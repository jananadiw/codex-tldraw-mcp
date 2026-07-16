import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createShapeId, TLShape, toRichText } from 'tldraw'
import { compareCodeGraphs } from '../src/codeGraphDrift.js'
import { scanCodeGraph } from '../src/codeGraphScanner.js'
import {
  appendCodeGraphDiagram,
  appendWorkflowDiagram,
  applyCodeGraphDrift,
  loadBoard,
  readStoredCodeGraph,
  saveBoard,
  summarizeBoard,
} from '../src/tldrawBoard.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tldraw-code-graph-'))
const boardName = 'drift'
const mainSource = `import { service } from './service.js'
import('external-package')
const example = "import './fake.js'"
export async function run() {
  const { lazy } = await import('./lazy.js')
  return service + lazy
}
// import './commented-out.js'
void example
`

try {
  await verifyScannerSyntax()
  await writeFixture(root, {
    'package.json': '{"name":"drift-fixture"}\n',
    'src/lazy.ts': 'export const lazy = 2\n',
    'src/main.ts': mainSource,
    'src/service.ts': 'export const service = 1\n',
  })

  const initialGraph = await scanCodeGraph(root)
  assertCounts(initialGraph.nodes.length, 3, 'initial modules')
  assertCounts(initialGraph.edges.length, 2, 'initial local imports')
  assertCounts(initialGraph.externalImportCount, 1, 'initial external imports')
  assertCounts(initialGraph.unresolvedImports.length, 0, 'initial unresolved imports')
  await withMcpClient(async (client) => {
    const tools = await client.listTools()
    for (const toolName of ['diagram_code_graph', 'compare_code_graph']) {
      if (!tools.tools.some((tool) => tool.name === toolName)) throw new Error(`MCP server did not register ${toolName}.`)
    }
    const result = await client.callTool({
      name: 'diagram_code_graph',
      arguments: { repoPath: root, boardName: 'mcp-integration' },
    })
    if (result.isError || readNumber(result.structuredContent, 'nodeCount') !== 3) {
      throw new Error('diagram_code_graph failed through the stdio MCP transport.')
    }
  })

  const store = await loadBoard(boardName, root)
  const diagram = appendCodeGraphDiagram(store, initialGraph)
  const mainShape = findGraphShape(store, diagram.diagramId, 'node', 'src/main.ts')
  if (!('w' in mainShape.props) || !('h' in mainShape.props)) throw new Error('Code graph node has no size.')
  const editedWidth = mainShape.props.w + 31
  const editedHeight = mainShape.props.h + 19
  const editedMainShape = {
    ...mainShape,
    x: mainShape.x + 77,
    props: {
      ...mainShape.props,
      color: 'green',
      w: editedWidth,
      h: editedHeight,
      richText: toRichText('Custom main module label'),
    },
  } as TLShape
  store.put([editedMainShape])

  const title = allShapes(store).find((shape) => shape.meta?.tldrawMcp && !readGraphMeta(shape)?.elementId)
  if (!title) throw new Error('Code graph title shape was not created.')
  const manualShape = {
    ...title,
    id: createShapeId('manual-note'),
    x: title.x,
    y: title.y - 100,
    props: { ...title.props, richText: toRichText('Manual repository note') },
    meta: {},
  } as TLShape
  store.put([manualShape])
  const unrelatedDiagram = appendWorkflowDiagram(store, {
    repoName: 'Unrelated workflow',
    repoPath: root,
    steps: [{ id: 'unrelated', label: 'Unrelated generated diagram', evidence: [] }],
    connections: [],
  })
  const originalUnrelatedDiagram = serializeDiagram(store, unrelatedDiagram.diagramId)
  const boardPath = await saveBoard(boardName, store, root)
  const originalManualShape = JSON.stringify(manualShape)

  await fs.rm(path.join(root, 'src/lazy.ts'))
  await writeFixture(root, {
    'src/main.ts': `import { service } from './service'
import { replacement } from './replacement.js'
import './missing.js'
export function run() {
  return service + replacement
}
`,
    'src/replacement.ts': 'export const replacement = 3\n',
  })

  const changedGraph = await scanCodeGraph(root)
  assertCounts(changedGraph.unresolvedImports.length, 1, 'changed unresolved imports')
  const previewStore = await loadBoard(boardName, root)
  const beforePreview = await fs.readFile(boardPath, 'utf8')
  const preview = compareCodeGraphs(readStoredCodeGraph(previewStore, diagram.diagramId), changedGraph)
  const afterPreview = await fs.readFile(boardPath, 'utf8')
  if (beforePreview !== afterPreview) throw new Error('Drift preview modified the board file.')
  assertCounts(preview.counts.unchanged, 2, 'unchanged graph elements')
  assertCounts(preview.counts.changed, 1, 'changed graph elements')
  assertCounts(preview.counts.stale, 2, 'stale graph elements')
  assertCounts(preview.counts.new, 2, 'new graph elements')
  await withMcpClient(async (client) => {
    const integrationBoardPath = path.join(root, 'boards/mcp-integration.tldr')
    const beforeToolPreview = await fs.readFile(integrationBoardPath, 'utf8')
    const result = await client.callTool({
      name: 'compare_code_graph',
      arguments: { repoPath: root, boardName: 'mcp-integration' },
    })
    const counts = readRecord(result.structuredContent, 'counts')
    if (result.isError || counts.stale !== 2 || counts.changed !== 1 || counts.new !== 2) {
      throw new Error('compare_code_graph returned incorrect drift through the stdio MCP transport.')
    }
    if (beforeToolPreview !== await fs.readFile(integrationBoardPath, 'utf8')) {
      throw new Error('compare_code_graph preview wrote the board through the stdio MCP transport.')
    }
    const applied = await client.callTool({
      name: 'compare_code_graph',
      arguments: { repoPath: root, boardName: 'mcp-integration', applyMarkers: true },
    })
    if (applied.isError || (readNumber(applied.structuredContent, 'updatedShapeCount') ?? 0) < 3) {
      throw new Error('compare_code_graph did not apply markers through the stdio MCP transport.')
    }
  })

  const updatedShapeCount = applyCodeGraphDrift(previewStore, preview)
  if (updatedShapeCount < 3) throw new Error('Drift application did not update every changed or stale graph shape.')
  await saveBoard(boardName, previewStore, root)

  const markedStore = await loadBoard(boardName, root)
  assertShapeState(markedStore, diagram.diagramId, 'node', 'src/main.ts', 'changed', 'orange', 'dashed')
  assertShapeState(markedStore, diagram.diagramId, 'node', 'src/lazy.ts', 'stale', 'red', 'dashed')
  assertShapeState(
    markedStore,
    diagram.diagramId,
    'edge',
    'dynamic-import:src/main.ts=>src/lazy.ts',
    'stale',
    'red',
    'dashed'
  )
  const markedMainShape = findGraphShape(markedStore, diagram.diagramId, 'node', 'src/main.ts')
  if (markedMainShape.x !== editedMainShape.x) throw new Error('Drift markers changed a user-positioned node.')
  if (
    !('w' in markedMainShape.props) ||
    !('h' in markedMainShape.props) ||
    markedMainShape.props.w !== editedWidth ||
    markedMainShape.props.h !== editedHeight
  ) {
    throw new Error('Drift markers changed a user-sized node.')
  }
  if (shapeText(markedMainShape) !== 'Custom main module label') throw new Error('Drift markers changed a user-edited label.')
  const persistedManualShape = allShapes(markedStore).find((shape) => shape.id === manualShape.id)
  if (JSON.stringify(persistedManualShape) !== originalManualShape) throw new Error('Drift markers changed a manual shape.')
  if (serializeDiagram(markedStore, unrelatedDiagram.diagramId) !== originalUnrelatedDiagram) {
    throw new Error('Drift markers changed an unrelated generated diagram.')
  }

  const beforeSecondApply = await fs.readFile(boardPath, 'utf8')
  const secondDrift = compareCodeGraphs(readStoredCodeGraph(markedStore, diagram.diagramId), changedGraph)
  if (applyCodeGraphDrift(markedStore, secondDrift) !== 0) throw new Error('Applying the same drift markers was not idempotent.')
  await saveBoard(boardName, markedStore, root)
  const afterSecondApply = await fs.readFile(boardPath, 'utf8')
  if (beforeSecondApply !== afterSecondApply) throw new Error('An idempotent drift application changed the board file.')

  await fs.rm(path.join(root, 'src/replacement.ts'))
  await writeFixture(root, {
    'src/lazy.ts': 'export const lazy = 2\n',
    'src/main.ts': mainSource,
  })
  const restoredGraph = await scanCodeGraph(root)
  const restoredStore = await loadBoard(boardName, root)
  const restoredDrift = compareCodeGraphs(readStoredCodeGraph(restoredStore, diagram.diagramId), restoredGraph)
  assertCounts(restoredDrift.counts.unchanged, 5, 'restored unchanged elements')
  assertCounts(restoredDrift.counts.changed, 0, 'restored changed elements')
  assertCounts(restoredDrift.counts.stale, 0, 'restored stale elements')
  assertCounts(restoredDrift.counts.new, 0, 'restored new elements')
  applyCodeGraphDrift(restoredStore, restoredDrift)
  await saveBoard(boardName, restoredStore, root)

  const finalStore = await loadBoard(boardName, root)
  assertShapeState(finalStore, diagram.diagramId, 'node', 'src/main.ts', 'unchanged', 'green', 'solid')
  assertShapeState(finalStore, diagram.diagramId, 'node', 'src/lazy.ts', 'unchanged', 'blue', 'solid')
  const finalBoard = await fs.readFile(boardPath, 'utf8')
  if (finalBoard.includes(root)) throw new Error('The code graph board stored an absolute repository path.')

  const summary = await summarizeBoard(boardName, root)
  const graphSummary = summary.diagrams.find((entry) => entry.diagramId === diagram.diagramId)
  if (graphSummary?.diagramType !== 'code-graph') throw new Error('Board summary did not identify the code graph.')
  assertCounts(graphSummary.driftStatusCounts?.unchanged ?? 0, 5, 'summary unchanged elements')

  const metadataShape = findGraphShape(finalStore, diagram.diagramId, 'node', 'src/main.ts')
  const originalMetadataShape = { ...metadataShape, meta: { ...metadataShape.meta } }
  const graphMeta = readGraphMeta(metadataShape)
  if (!graphMeta) throw new Error('Code graph node lost its metadata.')
  finalStore.put([withGraphMeta(metadataShape, { ...graphMeta, metadataVersion: 999 })])
  expectStoredGraphError(finalStore, diagram.diagramId, 'unsupported metadata version')
  const incompleteMeta = { ...graphMeta }
  delete incompleteMeta.fingerprint
  finalStore.put([withGraphMeta(metadataShape, incompleteMeta)])
  expectStoredGraphError(finalStore, diagram.diagramId, 'incomplete metadata')
  finalStore.put([originalMetadataShape as TLShape])

  await fs.rm(path.join(root, 'src'), { recursive: true })
  const emptyGraph = await scanCodeGraph(root)
  assertCounts(emptyGraph.nodes.length, 0, 'empty graph modules')
  const emptyDrift = compareCodeGraphs(readStoredCodeGraph(finalStore, diagram.diagramId), emptyGraph)
  assertCounts(emptyDrift.counts.stale, 5, 'empty graph stale elements')
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: 'compare_code_graph',
      arguments: { repoPath: root, boardName: 'mcp-integration' },
    })
    if (result.isError || readRecord(result.structuredContent, 'counts').stale !== 5) {
      throw new Error('compare_code_graph could not report an entirely stale graph.')
    }
  })

  const legacyStore = await loadBoard('legacy', root)
  appendWorkflowDiagram(legacyStore, {
    repoName: 'Legacy workflow',
    repoPath: root,
    steps: [{ id: 'legacy', label: 'Legacy step', evidence: [] }],
    connections: [],
  })
  try {
    readStoredCodeGraph(legacyStore)
    throw new Error('Expected a legacy workflow board to reject code graph comparison.')
  } catch (error) {
    if (!String((error as Error).message).includes('diagram_code_graph')) throw error
  }

  console.log(
    JSON.stringify(
      {
        boardPath,
        diagramId: diagram.diagramId,
        initial: { nodes: initialGraph.nodes.length, edges: initialGraph.edges.length },
        drift: preview.counts,
        restored: restoredDrift.counts,
      },
      null,
      2
    )
  )
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

process.exit(0)

async function writeFixture(root: string, files: Record<string, string>) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, contents)
  }
}

function allShapes(store: Awaited<ReturnType<typeof loadBoard>>) {
  return store.allRecords().filter((record): record is TLShape => record.typeName === 'shape')
}

function serializeDiagram(store: Awaited<ReturnType<typeof loadBoard>>, diagramId: string) {
  return JSON.stringify(
    allShapes(store)
      .filter((shape) => readGraphMeta(shape)?.diagramId === diagramId)
      .sort((a, b) => a.id.localeCompare(b.id))
  )
}

function findGraphShape(
  store: Awaited<ReturnType<typeof loadBoard>>,
  diagramId: string,
  elementKind: 'edge' | 'node',
  elementId: string
) {
  const shape = allShapes(store).find((candidate) => {
    const meta = readGraphMeta(candidate)
    return meta?.diagramId === diagramId && meta.elementKind === elementKind && meta.elementId === elementId
  })
  if (!shape) throw new Error(`Graph shape not found: ${elementKind}:${elementId}`)
  return shape
}

function assertShapeState(
  store: Awaited<ReturnType<typeof loadBoard>>,
  diagramId: string,
  elementKind: 'edge' | 'node',
  elementId: string,
  status: string,
  color: string,
  dash: string
) {
  const shapes = allShapes(store).filter((candidate) => {
    const meta = readGraphMeta(candidate)
    return meta?.diagramId === diagramId && meta.elementKind === elementKind && meta.elementId === elementId
  })
  if (shapes.length === 0) throw new Error(`Graph shapes not found: ${elementKind}:${elementId}`)
  for (const shape of shapes) {
    const meta = readGraphMeta(shape)
    const shapeColor = 'color' in shape.props ? shape.props.color : undefined
    const shapeDash = 'dash' in shape.props ? shape.props.dash : undefined
    if (meta?.driftStatus !== status || shapeColor !== color || shapeDash !== dash) {
      throw new Error(`Unexpected graph shape state for ${elementKind}:${elementId}.`)
    }
  }
}

function readGraphMeta(shape: TLShape) {
  const meta = shape.meta?.tldrawMcp
  if (!meta || typeof meta !== 'object') return null
  return meta as {
    diagramId?: string
    elementKind?: 'edge' | 'node'
    elementId?: string
    driftStatus?: string
    fingerprint?: string
    metadataVersion?: number
  }
}

function withGraphMeta(shape: TLShape, graphMeta: Record<string, unknown>) {
  return {
    ...shape,
    meta: { ...shape.meta, tldrawMcp: graphMeta },
  } as TLShape
}

function expectStoredGraphError(
  store: Awaited<ReturnType<typeof loadBoard>>,
  diagramId: string,
  expectedMessage: string
) {
  try {
    readStoredCodeGraph(store, diagramId)
    throw new Error(`Expected code graph metadata validation to report ${expectedMessage}.`)
  } catch (error) {
    if (!String((error as Error).message).includes(expectedMessage)) throw error
  }
}

function shapeText(shape: TLShape) {
  if (!('richText' in shape.props)) return ''
  return richTextToPlainText(shape.props.richText)
}

function richTextToPlainText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: string; content?: unknown[]; type?: string }
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  return node.content.map(richTextToPlainText).join(node.type === 'doc' ? '\n' : '')
}

function assertCounts(actual: number, expected: number, label: string) {
  if (actual !== expected) throw new Error(`Expected ${expected} ${label}, found ${actual}.`)
}

async function verifyScannerSyntax() {
  const syntaxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tldraw-code-syntax-'))
  try {
    await writeFixture(syntaxRoot, {
      'src/classic.js': 'export const classic = true\n',
      'src/component.jsx': 'export function Component() { return <div /> }\n',
      'src/entry.ts': `export { value } from './value.js'\nconst legacy = require('./legacy.cjs')\nimport('./lazy.mjs')\nvoid legacy\n`,
      'src/extra.mts': 'export const extra = true\n',
      'src/ghost.ts': 'export const ghost = true\n',
      'src/lazy.mjs': "import './typed.cts'\nexport const lazy = true\n",
      'src/legacy.cjs': 'module.exports = 1\n',
      'src/regex.js': `const marker = /[/*]/\nimport './real.js'\nvoid marker\n`,
      'src/real.js': 'export const real = true\n',
      'src/typed.cts': 'export const typed = true\n',
      'src/value.ts': 'export const value = true\n',
      'src/view.tsx': 'export function Docs() { return <pre>import value from "./ghost"</pre> }\n',
    })
    const graph = await scanCodeGraph(syntaxRoot)
    for (const extension of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']) {
      if (!graph.nodes.some((node) => node.id.endsWith(extension))) {
        throw new Error(`Code graph scanner did not include ${extension} modules.`)
      }
    }
    for (const kind of ['dynamic-import', 'import', 're-export', 'require']) {
      if (!graph.edges.some((edge) => edge.kind === kind)) throw new Error(`Code graph scanner missed ${kind}.`)
    }
    if (!graph.edges.some((edge) => edge.from === 'src/regex.js' && edge.to === 'src/real.js')) {
      throw new Error('A regular expression caused the scanner to miss a valid import.')
    }
    if (graph.edges.some((edge) => edge.from === 'src/view.tsx' && edge.to === 'src/ghost.ts')) {
      throw new Error('JSX text produced a false code graph import.')
    }
  } finally {
    await fs.rm(syntaxRoot, { recursive: true, force: true })
  }
}

async function withMcpClient(run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'code-graph-smoke', version: '1.0.0' })
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

function readRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  const entry = (value as Record<string, unknown>)[key]
  return entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
}

function readNumber(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined
  const entry = (value as Record<string, unknown>)[key]
  return typeof entry === 'number' ? entry : undefined
}
