import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendWorkflowDiagram, listBoardNames, loadBoard, saveBoard, summarizeBoard } from './tldrawBoard.js'
import { boardPath, normalizeBoardName, workspaceRoot } from './paths.js'
import { scanRepo } from './repoScanner.js'

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

  const server = new McpServer(
    {
      name: 'codex-tldraw-mcp',
      version: '0.1.0',
    },
    {
      instructions:
        'Use diagram_repo to create a simple product workflow diagram in a tldraw .tldr board. If the board already has shapes, the server appends the new diagram to the right instead of clearing the canvas.',
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
      const store = await loadBoard(normalizedBoardName, resolvedRepoPath)
      const diagram = appendWorkflowDiagram(store, workflow)
      const writtenPath = await saveBoard(normalizedBoardName, store, resolvedRepoPath)
      const result = {
        boardName: normalizedBoardName,
        boardPath: writtenPath,
        repoPath: resolvedRepoPath,
        diagramId: diagram.diagramId,
        stepCount: workflow.steps.length,
        connectionCount: workflow.connections.length,
        shapeCount: diagram.shapeCount,
        appended: diagram.appended,
      }

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
