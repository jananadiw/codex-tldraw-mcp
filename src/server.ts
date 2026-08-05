import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendArchitectureDiagram } from './architectureBoard.js'
import { ARCHITECTURE_ANALYSIS_INSTRUCTIONS, buildArchitectureDiagram } from './architectureDiagram.js'
import { compareCodeGraphs } from './codeGraphDrift.js'
import { scanCodeGraph } from './codeGraphScanner.js'
import {
  appendCodeGraphDiagram,
  appendWorkflowDiagram,
  applyCodeGraphDrift,
  listBoardNames,
  loadBoard,
  readStoredCodeGraph,
  saveBoard,
  summarizeBoard,
} from './tldrawBoard.js'
import { boardPath, normalizeBoardName, workspaceRoot } from './paths.js'
import { buildPromptWorkflow } from './promptWorkflow.js'
import { scanRepo } from './repoScanner.js'
import type { ProductWorkflow } from './types.js'

const repoPathInput = z
  .string()
  .optional()
  .describe('Absolute or relative path to the repository. Defaults to the MCP server working directory.')

const diagramRepoInput = {
  repoPath: repoPathInput,
  boardName: z
    .string()
    .optional()
    .describe('Board name under the target repository boards directory. Defaults to "main".'),
}

const compareCodeGraphInput = {
  ...diagramRepoInput,
  diagramId: z
    .string()
    .optional()
    .describe('Code graph diagram id to compare. Defaults to the newest trackable code graph on the board.'),
  applyMarkers: z
    .boolean()
    .optional()
    .describe('When true, marks changed elements orange and stale elements red. Defaults to a read-only preview.'),
}

const diagramStepInput = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/, 'Step id must contain only letters, numbers, dots, underscores, or dashes.')
    .optional()
    .describe('Stable step id used by connections. If omitted, one is generated from the label.'),
  label: z.string().min(1).describe('Short label shown inside the tldraw step shape.'),
  detail: z.string().optional().describe('Optional second line of detail shown below the label.'),
})

const diagramConnectionInput = z.object({
  from: z.string().min(1).describe('Source step id.'),
  to: z.string().min(1).describe('Target step id.'),
  label: z.string().optional().describe('Optional label shown on the arrow.'),
})

const drawCanvasInput = {
  repoPath: repoPathInput,
  boardName: z
    .string()
    .optional()
    .describe('Board name under the target repository boards directory. Defaults to "main".'),
  title: z.string().min(1).describe('Diagram title shown above the generated tldraw shapes.'),
  steps: z.array(diagramStepInput).min(1).describe('Ordered steps, states, screens, or architecture nodes to draw.'),
  connections: z
    .array(diagramConnectionInput)
    .optional()
    .describe('Arrows between steps. If omitted, steps are connected sequentially from left to right.'),
}

const architectureEvidenceInput = z
  .array(z.string().min(1))
  .optional()
  .describe('Optional repository-relative files or symbols that support this item.')

const architectureComponentInput = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/, 'Component id must contain only letters, numbers, dots, underscores, or dashes.'),
  label: z.string().min(1).describe('Short component name shown in the diagram.'),
  actions: z
    .array(z.string().min(1).max(72))
    .min(1)
    .max(3)
    .describe('One to three short actions this component performs, in execution order.'),
  errors: z
    .array(z.string().min(1).max(60))
    .max(2)
    .optional()
    .describe('Up to two short caller-visible errors shown inside this component.'),
  evidence: architectureEvidenceInput,
})

const architectureConnectionInput = z.object({
  from: z.string().min(1).describe('Source component id.'),
  to: z.string().min(1).describe('Destination component id.'),
  call: z.string().min(1).max(32).describe('Short API call, event, or data transfer shown on the arrow.'),
  evidence: architectureEvidenceInput,
})

const drawArchitectureInput = {
  repoPath: repoPathInput,
  boardName: z
    .string()
    .optional()
    .describe('Board name under the target repository boards directory. Defaults to "main".'),
  title: z.string().min(1).describe('Architecture diagram title.'),
  components: z
    .array(architectureComponentInput)
    .min(2)
    .max(7)
    .describe('Two to seven main runtime components. Keep the list small.'),
  primaryFlow: z
    .array(z.string().min(1))
    .min(2)
    .max(4)
    .describe('Component ids in the main user flow, ordered from first action to final result.'),
  connections: z
    .array(architectureConnectionInput)
    .describe('One short connection per interaction. Combine request and response instead of adding a return arrow.'),
}

export function createServer() {
  let activeResourceRepoPath = workspaceRoot()

  async function resolveToolRepoPath(repoPath: string) {
    const resolvedRepoPath = await resolveRepoPath(repoPath)
    activeResourceRepoPath = resolvedRepoPath
    return resolvedRepoPath
  }

  async function resolveResourceRepoPath() {
    return resolveRepoPath(activeResourceRepoPath)
  }

  async function appendWorkflowToBoard(workflow: ProductWorkflow, boardName: string, repoPath: string) {
    const store = await loadBoard(boardName, repoPath)
    const diagram = appendWorkflowDiagram(store, workflow)
    const writtenPath = await saveBoard(boardName, store, repoPath)

    return {
      diagram,
      writtenPath,
      result: {
        boardName,
        boardPath: writtenPath,
        repoPath,
        diagramId: diagram.diagramId,
        stepCount: workflow.steps.length,
        connectionCount: workflow.connections.length,
        shapeCount: diagram.shapeCount,
        appended: diagram.appended,
      },
    }
  }

  const server = new McpServer(
    {
      name: 'codex-tldraw-mcp',
      version: '0.4.0',
    },
    {
      instructions: [
        'Use diagram_repo to infer a product workflow, draw_canvas for prompt-provided diagrams, draw_architecture for a simple component-and-call architecture view, diagram_code_graph for a trackable JavaScript or TypeScript module graph, and compare_code_graph to detect drift. Diagram tools append to tldraw .tldr boards instead of clearing the canvas.',
        ARCHITECTURE_ANALYSIS_INSTRUCTIONS,
      ].join('\n\n'),
    }
  )

  server.registerTool(
    'diagram_code_graph',
    {
      title: 'Diagram trackable code graph',
      description:
        'Scans repository-local JavaScript and TypeScript modules and appends a trackable module/import graph to a tldraw board.',
      inputSchema: diagramRepoInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ repoPath = workspaceRoot(), boardName = 'main' }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const graph = await scanCodeGraph(resolvedRepoPath)
      if (graph.nodes.length === 0) {
        throw new Error('No supported JavaScript or TypeScript modules were found in the repository.')
      }
      const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
      const diagram = appendCodeGraphDiagram(store, graph)
      const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
      const result = {
        boardName: normalizedBoardName,
        boardPath: writtenPath,
        repoPath: resolvedRepoPath,
        diagramId: diagram.diagramId,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        externalImportCount: graph.externalImportCount,
        unresolvedImports: graph.unresolvedImports,
        shapeCount: diagram.shapeCount,
        appended: diagram.appended,
      }

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: 'text',
            text: `Created a trackable code graph with ${graph.nodes.length} modules and ${graph.edges.length} local imports on board "${normalizedBoardName}". File: ${writtenPath}`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'compare_code_graph',
    {
      title: 'Compare code graph drift',
      description:
        'Compares the current JavaScript and TypeScript module graph with an existing trackable code graph. Preview is the default; applyMarkers updates only generated graph styling.',
      inputSchema: compareCodeGraphInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({
      repoPath = workspaceRoot(),
      boardName = 'main',
      diagramId,
      applyMarkers = false,
    }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const graph = await scanCodeGraph(resolvedRepoPath)
      const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
      const stored = readStoredCodeGraph(store, diagramId)
      const drift = compareCodeGraphs(stored, graph)
      const updatedShapeCount = applyMarkers ? applyCodeGraphDrift(store, drift) : 0
      const writtenPath = boardPath(normalizedBoardName, resolvedRepoPath)
      if (applyMarkers && updatedShapeCount > 0) {
        await saveBoard(normalizedBoardName, store, resolvedRepoPath)
      }
      const result = {
        boardName: normalizedBoardName,
        boardPath: writtenPath,
        repoPath: resolvedRepoPath,
        diagramId: drift.diagramId,
        applied: applyMarkers,
        updatedShapeCount,
        counts: drift.counts,
        elements: drift.elements,
        externalImportCount: graph.externalImportCount,
        unresolvedImports: graph.unresolvedImports,
      }

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: 'text',
            text: `${applyMarkers ? 'Applied' : 'Previewed'} code graph drift for "${normalizedBoardName}": ${drift.counts.stale} stale, ${drift.counts.changed} changed, ${drift.counts.new} new, and ${drift.counts.unchanged} unchanged elements.`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'diagram_repo',
    {
      title: 'Diagram product workflow',
      description:
        'Scans a local repository and appends a simple product workflow diagram to a tldraw board. Use this when the user asks Codex to draw what a project does.',
      inputSchema: diagramRepoInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ repoPath = workspaceRoot(), boardName = 'main' }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const workflow = await scanRepo(resolvedRepoPath)
      const { diagram, writtenPath, result } = await appendWorkflowToBoard(
        workflow,
        normalizedBoardName,
        resolvedRepoPath
      )

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: 'text',
            text: `Created ${diagram.appended ? 'a new appended' : 'an initial'} tldraw product workflow diagram for ${workflow.repoName} on board "${normalizedBoardName}". File: ${writtenPath}`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'draw_canvas',
    {
      title: 'Draw prompt-provided diagram',
      description:
        'Appends a prompt-provided workflow, state machine, architecture sketch, or plan to a tldraw board without scanning repository source.',
      inputSchema: drawCanvasInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ repoPath = workspaceRoot(), boardName = 'main', title, steps, connections }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const workflow = buildPromptWorkflow(title, resolvedRepoPath, steps, connections)
      const { diagram, writtenPath, result } = await appendWorkflowToBoard(
        workflow,
        normalizedBoardName,
        resolvedRepoPath
      )

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: 'text',
            text: `Created ${diagram.appended ? 'a new appended' : 'an initial'} tldraw diagram "${workflow.repoName}" on board "${normalizedBoardName}". File: ${writtenPath}`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'draw_architecture',
    {
      title: 'Draw simple system architecture',
      description:
        'Appends a simple architecture diagram with a straight main flow, supporting components below it, concise calls, and errors inside components. Inspect the codebase first and keep implementation libraries inside component actions.',
      inputSchema: drawArchitectureInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({
      repoPath = workspaceRoot(),
      boardName = 'main',
      title,
      components,
      primaryFlow,
      connections,
    }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const architecture = buildArchitectureDiagram(title, resolvedRepoPath, components, primaryFlow, connections)
      const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
      const diagram = appendArchitectureDiagram(store, architecture)
      const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
      const result = {
        boardName: normalizedBoardName,
        boardPath: writtenPath,
        repoPath: resolvedRepoPath,
        diagramId: diagram.diagramId,
        componentCount: architecture.components.length,
        connectionCount: architecture.connections.length,
        shapeCount: diagram.shapeCount,
        bindingCount: diagram.bindingCount,
        appended: diagram.appended,
      }

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: 'text',
            text: `Created ${diagram.appended ? 'an appended' : 'an initial'} architecture diagram "${architecture.title}" with ${architecture.components.length} components and ${architecture.connections.length} connections on board "${normalizedBoardName}". File: ${writtenPath}`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description: 'Lists tldraw boards stored under the target repository boards directory.',
      inputSchema: {
        repoPath: repoPathInput,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ repoPath = workspaceRoot() }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const boards = await listBoardNames(resolvedRepoPath)
      return {
        structuredContent: { boards, repoPath: resolvedRepoPath },
        content: [{ type: 'text', text: boards.length ? boards.join('\n') : 'No boards found.' }],
      }
    }
  )

  server.registerTool(
    'read_board_summary',
    {
      title: 'Read board summary',
      description: 'Summarizes shapes and workflow diagrams in a tldraw board.',
      inputSchema: {
        repoPath: repoPathInput,
        boardName: z
          .string()
          .optional()
          .describe('Board name under the target repository boards directory. Defaults to "main".'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ repoPath = workspaceRoot(), boardName = 'main' }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const summary = await summarizeBoard(normalizedBoardName, resolvedRepoPath)
      return {
        structuredContent: summary as unknown as Record<string, unknown>,
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      }
    }
  )

  server.registerResource(
    'board-summary',
    new ResourceTemplate('tldraw://boards/{name}/summary', {
      list: async () => {
        const repoPath = await resolveResourceRepoPath()
        const boards = await listBoardNames(repoPath)
        return {
          resources: boards.map((name) => ({
            name: `${name} summary`,
            uri: `tldraw://boards/${name}/summary`,
            mimeType: 'application/json',
          })),
        }
      },
    }),
    {
      title: 'Board summary',
      description: 'Summary of a tldraw workflow board generated by this MCP server.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => {
      const repoPath = await resolveResourceRepoPath()
      const name = normalizeBoardName(String(variables.name))
      const summary = await summarizeBoard(name, repoPath)
      return {
        contents: [
          {
            uri: `tldraw://boards/${name}/summary`,
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      }
    }
  )

  server.registerResource(
    'board-file',
    new ResourceTemplate('tldraw://boards/{name}/file', {
      list: async () => {
        const repoPath = await resolveResourceRepoPath()
        const boards = await listBoardNames(repoPath)
        return {
          resources: boards.map((name) => ({
            name: `${name} tldraw file`,
            uri: `tldraw://boards/${name}/file`,
            mimeType: 'application/vnd.tldraw+json',
          })),
        }
      },
    }),
    {
      title: 'Board file',
      description: 'Raw .tldr file content for a generated board.',
      mimeType: 'application/vnd.tldraw+json',
    },
    async (_uri, variables) => {
      const repoPath = await resolveResourceRepoPath()
      const name = normalizeBoardName(String(variables.name))
      return {
        contents: [
          {
            uri: `tldraw://boards/${name}/file`,
            mimeType: 'application/vnd.tldraw+json',
            text: await fs.readFile(boardPath(name, repoPath), 'utf8'),
          },
        ],
      }
    }
  )

  return server
}

async function resolveRepoPath(repoPath: string) {
  const resolvedRepoPath = path.resolve(workspaceRoot(), repoPath)
  const realRepoPath = await fs.realpath(resolvedRepoPath)
  const allowedRoots = await allowedRootPaths()

  if (
    allowedRoots.length > 0 &&
    !allowedRoots.some((root) => realRepoPath === root || realRepoPath.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(
      `Repo path is outside TLDRAW_MCP_ALLOWED_ROOTS: ${realRepoPath}. Set TLDRAW_MCP_ALLOWED_ROOTS to allow this directory.`
    )
  }

  return realRepoPath
}

async function allowedRootPaths() {
  const value = process.env.TLDRAW_MCP_ALLOWED_ROOTS
  if (!value) return []

  const roots = value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)

  return Promise.all(roots.map((root) => fs.realpath(path.resolve(workspaceRoot(), root))))
}
