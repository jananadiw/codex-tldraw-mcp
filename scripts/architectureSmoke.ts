import fs from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendArchitectureDiagram } from '../src/architectureBoard.js'
import { buildArchitectureDiagram } from '../src/architectureDiagram.js'
import { boardPath as resolveBoardPath } from '../src/paths.js'
import { loadBoard, saveBoard, summarizeBoard } from '../src/tldrawBoard.js'

const boardName = `architecture-smoke-${Date.now().toString(36)}`
const mcpBoardName = `${boardName}-mcp`
const boardRoot = process.cwd()
const architecture = buildArchitectureDiagram(
  'Handwriting font architecture',
  boardRoot,
  [
    {
      id: 'browser',
      label: 'Browser',
      actions: ['Validate and normalize the photo', 'Preview and download the font'],
      evidence: ['src/app.ts'],
    },
    {
      id: 'generate-api',
      label: 'Generate API',
      actions: ['Check the upload limit', 'Analyze the photo', 'Validate returned letter data'],
      errors: ['429 upload limit reached', '502 analysis failed'],
      evidence: ['src/api/generate.ts'],
    },
    {
      id: 'redis',
      label: 'Redis',
      actions: ['Limit each user to three uploads per day'],
      evidence: ['src/rateLimit.ts'],
    },
    {
      id: 'gemini',
      label: 'Gemini',
      actions: ['Detect handwritten letters', 'Return letter data as JSON'],
      evidence: ['src/gemini.ts'],
    },
    {
      id: 'web-worker',
      label: 'Web Worker',
      actions: ['Trace glyphs', 'Build and merge the TTF font'],
      evidence: ['src/fontWorker.ts'],
    },
  ],
  ['browser', 'generate-api', 'web-worker'],
  [
    {
      from: 'browser',
      to: 'generate-api',
      call: 'POST /generate with photo',
      evidence: ['src/app.ts', 'src/api/generate.ts'],
    },
    {
      from: 'generate-api',
      to: 'web-worker',
      call: 'Validated glyph data',
      evidence: ['src/api/generate.ts', 'src/fontWorker.ts'],
    },
    {
      from: 'generate-api',
      to: 'redis',
      call: 'Check upload limit',
      evidence: ['src/api/generate.ts', 'src/rateLimit.ts'],
    },
    {
      from: 'generate-api',
      to: 'gemini',
      call: 'Analyze photo ↔ glyph JSON',
      evidence: ['src/api/generate.ts', 'src/gemini.ts'],
    },
  ]
)

await withMcpClient(async (client) => {
  const tools = await client.listTools()
  const tool = tools.tools.find((candidate) => candidate.name === 'draw_architecture')
  if (!tool) throw new Error('MCP server did not register draw_architecture.')
  if (!tool.description?.includes('straight main flow')) {
    throw new Error('draw_architecture did not expose the flow-first architecture contract.')
  }

  const result = await client.callTool({
    name: 'draw_architecture',
    arguments: {
      repoPath: boardRoot,
      boardName: mcpBoardName,
      title: architecture.title,
      components: architecture.components,
      primaryFlow: architecture.primaryFlow,
      connections: architecture.connections,
    },
  })
  if (
    result.isError ||
    readNumber(result.structuredContent, 'componentCount') !== architecture.components.length ||
    readNumber(result.structuredContent, 'bindingCount') !== architecture.connections.length * 2
  ) {
    throw new Error('draw_architecture failed through the stdio MCP transport.')
  }
})

const mcpSummary = await summarizeBoard(mcpBoardName, boardRoot)
if (mcpSummary.diagrams[0]?.diagramType !== 'architecture') {
  throw new Error('draw_architecture did not persist architecture metadata through the MCP transport.')
}

const store = await loadBoard(boardName, boardRoot)
const rendered = appendArchitectureDiagram(store, architecture)
const boardPath = await saveBoard(boardName, store, boardRoot)
const raw = JSON.parse(await fs.readFile(boardPath, 'utf8')) as { records?: RawRecord[] }

if (!Array.isArray(raw.records)) throw new Error('Architecture smoke board did not write tldraw records.')
assertComponents(raw.records, rendered.diagramId)
assertConnections(raw.records, rendered.diagramId)
assertValidation()

console.log(
  JSON.stringify(
    {
      boardName,
      boardPath,
      diagramId: rendered.diagramId,
      componentCount: architecture.components.length,
      connectionCount: architecture.connections.length,
      shapeCount: rendered.shapeCount,
      bindingCount: rendered.bindingCount,
    },
    null,
    2
  )
)

if (!process.env.TLDRAW_MCP_KEEP_SMOKE_BOARD) await fs.rm(boardPath, { force: true })
await fs.rm(resolveBoardPath(mcpBoardName, boardRoot), { force: true })
process.exit(0)

type RawRecord = {
  id?: string
  typeName?: string
  type?: string
  fromId?: string
  props?: {
    terminal?: string
    normalizedAnchor?: { x?: number; y?: number }
  }
  meta?: {
    tldrawMcp?: {
      diagramId?: string
      diagramType?: string
      kind?: string
      elementId?: string
      actions?: string[]
      errors?: string[]
      call?: string
    }
  }
  x?: number
  y?: number
}

function assertComponents(records: RawRecord[], diagramId: string) {
  const components = records.filter(
    (record) =>
      record.typeName === 'shape' &&
      record.meta?.tldrawMcp?.diagramId === diagramId &&
      record.meta?.tldrawMcp?.kind === 'component'
  )
  if (components.length !== architecture.components.length) {
    throw new Error(`Expected ${architecture.components.length} components, found ${components.length}.`)
  }
  for (const component of components) {
    if ((component.meta?.tldrawMcp?.actions?.length ?? 0) === 0) {
      throw new Error(`Component ${component.id} has no actions.`)
    }
  }
  const generateApi = components.find((component) => component.meta?.tldrawMcp?.elementId === 'generate-api')
  const redis = components.find((component) => component.meta?.tldrawMcp?.elementId === 'redis')
  if (generateApi?.meta?.tldrawMcp?.errors?.length !== 2) {
    throw new Error('Architecture did not persist component errors.')
  }
  if ((redis?.y ?? 0) <= (generateApi?.y ?? 0)) {
    throw new Error('Architecture did not place supporting services below the primary flow.')
  }
}

function assertConnections(records: RawRecord[], diagramId: string) {
  const arrows = records.filter(
    (record) =>
      record.typeName === 'shape' &&
      record.type === 'arrow' &&
      record.meta?.tldrawMcp?.diagramId === diagramId &&
      record.meta?.tldrawMcp?.kind === 'connection'
  )
  const bindings = records.filter(
    (record) =>
      record.typeName === 'binding' &&
      record.type === 'arrow' &&
      record.meta?.tldrawMcp?.diagramId === diagramId
  )
  if (arrows.length !== architecture.connections.length) {
    throw new Error(`Expected ${architecture.connections.length} arrows, found ${arrows.length}.`)
  }
  if (bindings.length !== architecture.connections.length * 2) {
    throw new Error(`Expected ${architecture.connections.length * 2} bindings, found ${bindings.length}.`)
  }
  for (const arrow of arrows) {
    if (!arrow.meta?.tldrawMcp?.call) throw new Error(`Connection ${arrow.id} has no call label.`)
    if (bindings.filter((binding) => binding.fromId === arrow.id).length !== 2) {
      throw new Error(`Connection ${arrow.id} does not have two endpoint bindings.`)
    }
  }
  const supportStartAnchors = bindings
    .filter(
      (binding) =>
        binding.props?.terminal === 'start' &&
        ['generate-api->redis:2', 'generate-api->gemini:3'].includes(binding.meta?.tldrawMcp?.elementId ?? '')
    )
    .map((binding) => binding.props?.normalizedAnchor?.x)
  if (supportStartAnchors.length !== 2 || new Set(supportStartAnchors).size !== 2) {
    throw new Error('Supporting service arrows did not use separate component ports.')
  }
}

function assertValidation() {
  expectError(() => buildArchitectureDiagram('Empty', boardRoot, [], [], []), 'requires at least one component')
  expectError(
    () =>
      buildArchitectureDiagram(
        'Missing action',
        boardRoot,
        [
          { id: 'component', label: 'Component', actions: [] },
          { id: 'next', label: 'Next', actions: ['Work'] },
        ],
        ['component', 'next'],
        [{ from: 'component', to: 'next', call: 'Continue' }]
      ),
    'requires at least one action'
  )
  expectError(
    () =>
      buildArchitectureDiagram(
        'Unknown component',
        boardRoot,
        [
          { id: 'component', label: 'Component', actions: ['Work'] },
          { id: 'next', label: 'Next', actions: ['Work'] },
        ],
        ['component', 'next'],
        [{ from: 'component', to: 'missing', call: 'Call' }]
      ),
    'unknown destination component'
  )
  expectError(
    () =>
      buildArchitectureDiagram(
        'Duplicate interaction',
        boardRoot,
        [
          { id: 'component', label: 'Component', actions: ['Work'] },
          { id: 'next', label: 'Next', actions: ['Work'] },
        ],
        ['component', 'next'],
        [
          { from: 'component', to: 'next', call: 'Request' },
          { from: 'next', to: 'component', call: 'Response' },
        ]
      ),
    'one combined request/response connection'
  )
}

function expectError(action: () => unknown, message: string) {
  try {
    action()
  } catch (error) {
    if (String((error as Error).message).includes(message)) return
    throw error
  }
  throw new Error(`Expected validation error containing "${message}".`)
}

async function withMcpClient(run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'architecture-smoke', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  await client.connect(transport)
  try {
    await run(client)
  } finally {
    await client.close()
  }
}

function readNumber(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'number' ? entry : undefined
}
