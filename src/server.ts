import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardResourceUri } from './boardResource.js'
import { withBoardLock } from './boardLock.js'
import { appendArchitectureDiagram } from './architectureBoard.js'
import { ARCHITECTURE_ANALYSIS_INSTRUCTIONS, buildArchitectureDiagram } from './architectureDiagram.js'
import { compareCodeGraphs } from './codeGraphDrift.js'
import { scanCodeGraph } from './codeGraphScanner.js'
import {
  appendCodeGraphDiagram,
  assertBoardLocation,
  boardEtag,
  parseBoardFile,
  readBoardFile,
  appendWorkflowDiagram,
  applyCodeGraphDrift,
  listBoardNames,
  loadBoard,
  readStoredCodeGraph,
  saveBoard,
  summarizeBoard,
} from './tldrawBoard.js'
import { boardPath, normalizeBoardName, svgPath, workspaceRoot } from './paths.js'
import { buildPromptWorkflow } from './promptWorkflow.js'
import { scanRepo } from './repoScanner.js'
import type { ProductWorkflow } from './types.js'

const TLDRAW_APP_URI = 'ui://codex-tldraw/board.html'
const DIAGRAM_TOOL_UI_META = {
  _meta: {
    ui: { resourceUri: TLDRAW_APP_URI },
  },
} as const
const serverFilePath = fileURLToPath(import.meta.url)
const appHtmlPath = serverFilePath.endsWith('.ts')
  ? path.resolve(path.dirname(serverFilePath), '../dist/app.html')
  : path.resolve(path.dirname(serverFilePath), 'app.html')

const repoPathInput = z
  .string()
  .optional()
  .describe('Path to the repository. Always pass the absolute project path when using the plugin; its working directory is the plugin installation, not the user repository. Standalone MCP calls default to the server working directory.')

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
  let activeResourceRepoPath: string | undefined = process.env.TLDRAW_MCP_PLUGIN_ROOT ? undefined : workspaceRoot()

  async function resolveToolRepoPath(repoPath?: string) {
    const resolvedRepoPath = await resolveRepoPath(repoPath)
    activeResourceRepoPath = resolvedRepoPath
    return resolvedRepoPath
  }

  async function resolveResourceRepoPath() {
    if (!activeResourceRepoPath) throw new Error('This legacy board link has no repository path. Run the diagram tool again to obtain a repository-scoped link.')
    return resolveRepoPath(activeResourceRepoPath)
  }

  async function appendWorkflowToBoard(workflow: ProductWorkflow, boardName: string, repoPath: string) {
    return withBoardLock(boardPath(boardName, repoPath), async () => {
      const store = await loadBoard(boardName, repoPath)
      const diagram = appendWorkflowDiagram(store, workflow)
      const writtenPath = await saveBoard(boardName, store, repoPath)
      const writtenSvgPath = svgPath(boardName, repoPath)

      return {
        diagram,
        writtenPath,
        writtenSvgPath,
        result: {
          boardName,
          boardPath: writtenPath,
          svgPath: writtenSvgPath,
          repoPath,
          diagramId: diagram.diagramId,
          stepCount: workflow.steps.length,
          connectionCount: workflow.connections.length,
          shapeCount: diagram.shapeCount,
          appended: diagram.appended,
        },
      }
    })
  }

  const server = new McpServer(
    {
      name: 'codex-tldraw-mcp',
      version: '0.7.1',
    },
    {
      instructions: [
        'Use diagram_repo to infer a product workflow, draw_canvas for prompt-provided diagrams, draw_architecture for a simple component-and-call architecture view, diagram_code_graph for a trackable JavaScript or TypeScript module graph, and compare_code_graph to detect drift. Diagram tools append to tldraw .tldr boards instead of clearing the canvas.',
        'When running as a plugin, always pass the absolute path of the user project as repoPath on every tool call. Obtain it from the chat workspace or inspect the requested local checkout. Never use the plugin installation directory as the repository. For a remote repository URL, first clone it to a local checkout. For runtime architecture, inspect source and use draw_architecture; diagram_repo only infers a coarse product workflow from text signals.',
        ARCHITECTURE_ANALYSIS_INSTRUCTIONS,
      ].join('\n\n'),
    }
  )

  registerAppTool(
    server,
    'open_tldraw_file',
    {
      title: 'Open tldraw board',
      description: 'Opens a .tldr file in an interactive tldraw editor.',
      inputSchema: {
        file: z.object({
          name: z.string().min(1),
          resourceUri: z.string().trim().min(1),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { resourceUri: TLDRAW_APP_URI },
        'openai/ui': {
          entrypoints: [{ type: 'file', extensions: ['.tldr'] }],
        },
      },
    },
    async ({ file }) => ({
      structuredContent: { file },
      content: [
        {
          type: 'text',
          text: `Opened ${file.name} in the interactive tldraw editor.`,
        },
      ],
    })
  )

  registerAppTool(
    server,
    'save_board',
    {
      title: 'Save tldraw board',
      description: 'Writes .tldr and SVG preview updates from the MCP App editor.',
      inputSchema: {
        boardName: z.string().min(1),
        repoPath: repoPathInput,
        tldrJson: z.string().min(1),
        ifMatch: z.string().optional().describe('ETag from the loaded board. Rejects saves when the file changed.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: {
          resourceUri: TLDRAW_APP_URI,
          visibility: ['app'],
        },
      },
    },
    async ({ boardName, repoPath, tldrJson, ifMatch }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      return withBoardLock(boardPath(normalizedBoardName, resolvedRepoPath), async () => {
        // Validate in memory before touching either existing artifact.
        const store = parseBoardFile(tldrJson, normalizedBoardName)
        if (ifMatch) {
          const current = await readBoardFile(normalizedBoardName, resolvedRepoPath)
          if (boardEtag(current) !== ifMatch) {
            throw new Error('File changed outside this editor. Reload before saving.')
          }
        }
        const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
        return {
          structuredContent: {
            boardName: normalizedBoardName,
            boardPath: writtenPath,
            boardUri: boardResourceUri(resolvedRepoPath, normalizedBoardName),
            svgPath: svgPath(normalizedBoardName, resolvedRepoPath),
            repoPath: resolvedRepoPath,
            etag: boardEtag(await readBoardFile(normalizedBoardName, resolvedRepoPath)),
          },
          content: [{ type: 'text', text: `Saved board "${normalizedBoardName}" to ${writtenPath}.` }],
        }
      })
    }
  )

  registerAppResource(
    server,
    'codex-tldraw-editor',
    TLDRAW_APP_URI,
    {
      title: 'tldraw board editor',
      description: 'Interactive viewer and editor for .tldr board files.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: TLDRAW_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await fs.readFile(appHtmlPath, 'utf8'),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: ['https://cdn.tldraw.com'],
                resourceDomains: ['https://cdn.tldraw.com'],
              },
            },
            'openai/ui': {
              preferredDisplayMode: 'fullscreen',
              availableDisplayModes: ['inline', 'fullscreen'],
            },
          },
        },
      ],
    })
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
      ...DIAGRAM_TOOL_UI_META,
    },
    async ({ repoPath, boardName = 'main' }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      return withBoardLock(boardPath(normalizedBoardName, resolvedRepoPath), async () => {
        const graph = await scanCodeGraph(resolvedRepoPath)
        if (graph.nodes.length === 0) {
          throw new Error('No supported JavaScript or TypeScript modules were found in the repository.')
        }
        const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
        const diagram = appendCodeGraphDiagram(store, graph)
        const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
        const writtenSvgPath = svgPath(normalizedBoardName, resolvedRepoPath)
        const result = {
          boardName: normalizedBoardName,
          boardPath: writtenPath,
          svgPath: writtenSvgPath,
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
          content: boardArtifactContent(
            normalizedBoardName,
            resolvedRepoPath,
            `Created a trackable code graph with ${graph.nodes.length} modules and ${graph.edges.length} local imports on board "${normalizedBoardName}". Files: ${writtenPath}, ${writtenSvgPath}`
          ),
        }
      })
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
      ...DIAGRAM_TOOL_UI_META,
    },
    async ({
      repoPath,
      boardName = 'main',
      diagramId,
      applyMarkers = false,
    }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      return withBoardLock(boardPath(normalizedBoardName, resolvedRepoPath), async () => {
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
      })
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
      ...DIAGRAM_TOOL_UI_META,
    },
    async ({ repoPath, boardName = 'main' }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const workflow = await scanRepo(resolvedRepoPath)
      const { diagram, writtenPath, writtenSvgPath, result } = await appendWorkflowToBoard(
        workflow,
        normalizedBoardName,
        resolvedRepoPath
      )

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: boardArtifactContent(
          normalizedBoardName,
          resolvedRepoPath,
          `Created ${diagram.appended ? 'a new appended' : 'an initial'} tldraw product workflow diagram for ${workflow.repoName} on board "${normalizedBoardName}". Files: ${writtenPath}, ${writtenSvgPath}`
        ),
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
      ...DIAGRAM_TOOL_UI_META,
    },
    async ({ repoPath, boardName = 'main', title, steps, connections }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      const workflow = buildPromptWorkflow(title, resolvedRepoPath, steps, connections)
      const { diagram, writtenPath, writtenSvgPath, result } = await appendWorkflowToBoard(
        workflow,
        normalizedBoardName,
        resolvedRepoPath
      )

      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: boardArtifactContent(
          normalizedBoardName,
          resolvedRepoPath,
          `Created ${diagram.appended ? 'a new appended' : 'an initial'} tldraw diagram "${workflow.repoName}" on board "${normalizedBoardName}". Files: ${writtenPath}, ${writtenSvgPath}`
        ),
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
      ...DIAGRAM_TOOL_UI_META,
    },
    async ({
      repoPath,
      boardName = 'main',
      title,
      components,
      primaryFlow,
      connections,
    }) => {
      const resolvedRepoPath = await resolveToolRepoPath(repoPath)
      const normalizedBoardName = normalizeBoardName(boardName)
      return withBoardLock(boardPath(normalizedBoardName, resolvedRepoPath), async () => {
        const architecture = buildArchitectureDiagram(title, resolvedRepoPath, components, primaryFlow, connections)
        const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
        const diagram = appendArchitectureDiagram(store, architecture)
        const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
        const writtenSvgPath = svgPath(normalizedBoardName, resolvedRepoPath)
        const result = {
          boardName: normalizedBoardName,
          boardPath: writtenPath,
          svgPath: writtenSvgPath,
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
          content: boardArtifactContent(
            normalizedBoardName,
            resolvedRepoPath,
            `Created ${diagram.appended ? 'an appended' : 'an initial'} architecture diagram "${architecture.title}" with ${architecture.components.length} components and ${architecture.connections.length} connections on board "${normalizedBoardName}". Files: ${writtenPath}, ${writtenSvgPath}`
          ),
        }
      })
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
    async ({ repoPath }) => {
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
    async ({ repoPath, boardName = 'main' }) => {
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
        if (!activeResourceRepoPath) return { resources: [] }
        const repoPath = await resolveResourceRepoPath()
        const boards = await listBoardNames(repoPath)
        return {
          resources: boards.map((name) => ({
            name: `${name} summary`,
            uri: boardResourceUri(repoPath, name, 'summary'),
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
            uri: _uri.href,
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
        if (!activeResourceRepoPath) return { resources: [] }
        const repoPath = await resolveResourceRepoPath()
        const boards = await listBoardNames(repoPath)
        return {
          resources: boards.map((name) => ({
            name: `${name} tldraw file`,
            uri: boardResourceUri(repoPath, name),
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
            uri: _uri.href,
            mimeType: 'application/vnd.tldraw+json',
            text: await readBoardFile(name, repoPath),
          },
        ],
      }
    }
  )

  server.registerResource(
    'board-svg',
    new ResourceTemplate('tldraw://boards/{name}/svg', {
      list: async () => {
        if (!activeResourceRepoPath) return { resources: [] }
        const repoPath = await resolveResourceRepoPath()
        const boards = await listBoardNames(repoPath)
        return {
          resources: boards.map((name) => ({
            name: `${name} SVG preview`,
            uri: boardResourceUri(repoPath, name, 'svg'),
            mimeType: 'image/svg+xml',
          })),
        }
      },
    }),
    {
      title: 'Board SVG preview',
      description: 'Portable SVG preview of a generated tldraw board.',
      mimeType: 'image/svg+xml',
    },
    async (_uri, variables) => {
      const repoPath = await resolveResourceRepoPath()
      const name = normalizeBoardName(String(variables.name))
      await assertBoardLocation(svgPath(name, repoPath), repoPath)
      return {
        contents: [
          {
            uri: _uri.href,
            mimeType: 'image/svg+xml',
            text: await fs.readFile(svgPath(name, repoPath), 'utf8'),
          },
        ],
      }
    }
  )

  for (const kind of ['file', 'svg', 'summary'] as const) {
    const mimeType = kind === 'file' ? 'application/vnd.tldraw+json' : kind === 'svg' ? 'image/svg+xml' : 'application/json'
    server.registerResource(
      `repo-board-${kind}`,
      new ResourceTemplate(`tldraw://repos/{repo}/boards/{name}/${kind}`, { list: undefined }),
      { title: `Repository board ${kind}`, mimeType },
      async (uri, variables) => {
        const repoPath = await resolveRepoPath(decodeURIComponent(String(variables.repo)))
        const name = normalizeBoardName(decodeURIComponent(String(variables.name)))
        let text: string
        if (kind === 'summary') text = JSON.stringify(await summarizeBoard(name, repoPath), null, 2)
        else if (kind === 'file') text = await readBoardFile(name, repoPath)
        else {
          await assertBoardLocation(svgPath(name, repoPath), repoPath)
          text = await fs.readFile(svgPath(name, repoPath), 'utf8')
        }
        return { contents: [{ uri: uri.href, mimeType, text, _meta: { etag: boardEtag(text) } }] }
      }
    )
  }

  return server
}

function boardArtifactContent(boardName: string, repoPath: string, message: string) {
  return [
    { type: 'text' as const, text: message },
    {
      type: 'resource_link' as const,
      name: `${boardName}.tldr`,
      uri: boardResourceUri(repoPath, boardName),
      mimeType: 'application/vnd.tldraw+json',
    },
    {
      type: 'resource_link' as const,
      name: `${boardName}.svg`,
      uri: boardResourceUri(repoPath, boardName, 'svg'),
      mimeType: 'image/svg+xml',
    },
  ]
}

async function resolveRepoPath(repoPath?: string) {
  if (process.env.TLDRAW_MCP_PLUGIN_ROOT && !repoPath) {
    throw new Error('repoPath is required for plugin tools. Pass the absolute path of the user repository from the chat workspace.')
  }
  if (process.env.TLDRAW_MCP_PLUGIN_ROOT && repoPath && !path.isAbsolute(repoPath)) {
    throw new Error('Plugin tools require an absolute repoPath; relative paths resolve from the plugin installation, not the user repository.')
  }
  const resolvedRepoPath = path.resolve(workspaceRoot(), repoPath ?? workspaceRoot())
  const realRepoPath = await fs.realpath(resolvedRepoPath)
  const pluginRoot = process.env.TLDRAW_MCP_PLUGIN_ROOT
  if (pluginRoot && realRepoPath === await fs.realpath(pluginRoot)) {
    throw new Error('repoPath points to the plugin installation. Pass the absolute path of the user repository from the chat workspace. For a remote URL, clone the repository first.')
  }
  if (!(await fs.stat(realRepoPath)).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${realRepoPath}`)
  }
  const allowedRoots = await allowedRootPaths()

  if (
    allowedRoots.length > 0 &&
    !allowedRoots.some((root) => {
      const relative = path.relative(root, realRepoPath)
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
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
