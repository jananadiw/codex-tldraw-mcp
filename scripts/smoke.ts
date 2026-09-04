import fs from 'node:fs/promises'
import { svgPath as resolveSvgPath } from '../src/paths.js'
import { appendWorkflowDiagram, loadBoard, saveBoard, summarizeBoard } from '../src/tldrawBoard.js'
import { scanRepo } from '../src/repoScanner.js'
import { buildPromptWorkflow } from '../src/promptWorkflow.js'
import type { ProductWorkflow } from '../src/types.js'

const boardName = `smoke-${Date.now().toString(36)}`
const promptBoardName = `${boardName}-prompt`
const workflow = await scanRepo(process.cwd())
const boardRoot = workflow.repoPath
assertSequentialConnections(workflow, 'scanned repository workflow')

const sequentialPromptWorkflow = buildPromptWorkflow('Sequential prompt workflow', boardRoot, [
  { id: 'first', label: 'First' },
  { id: 'second', label: 'Second' },
  { id: 'third', label: 'Third' },
])
assertSequentialConnections(sequentialPromptWorkflow, 'prompt workflow')

const singleStepPromptWorkflow = buildPromptWorkflow('Single-step prompt workflow', boardRoot, [
  { id: 'only', label: 'Only' },
])
assertSequentialConnections(singleStepPromptWorkflow, 'single-step prompt workflow')

const firstStore = await loadBoard(boardName, boardRoot)
const first = appendWorkflowDiagram(firstStore, workflow)
await saveBoard(boardName, firstStore, boardRoot)
const previewPath = resolveSvgPath(boardName, boardRoot)
const firstPreview = await fs.readFile(previewPath, 'utf8')

const secondStore = await loadBoard(boardName, boardRoot)
const second = appendWorkflowDiagram(secondStore, workflow)
const boardPath = await saveBoard(boardName, secondStore, boardRoot)
const secondPreview = await fs.readFile(previewPath, 'utf8')

const summary = await summarizeBoard(boardName, boardRoot)
const raw = JSON.parse(await fs.readFile(boardPath, 'utf8')) as { records?: unknown[] }
const promptWorkflow = buildPromptWorkflow(
  'Visual stress & workflow',
  boardRoot,
  [
    {
      id: 's1',
      label: 'Visitor opens a complex onboarding checklist',
      detail: 'The first screen includes guidance, requirements, and status text plus extraordinarilylongunbrokentextthatmuststillfit inside the node.',
    },
    {
      id: 's2',
      label: 'User chooses email, SSO, or invite-link authentication',
      detail: 'Different paths are represented as a single workflow step so the diagram renderer must allow wrapping.',
    },
    {
      id: 's3',
      label: 'System validates organization policy and account eligibility',
      detail: 'Longer implementation details should increase the step height instead of spilling into nearby shapes.',
    },
    {
      id: 's4',
      label: 'User completes profile and accepts workspace defaults',
      detail: 'The fourth step forces the next step onto a new row in the generated board layout.',
    },
    {
      id: 's5',
      label: 'Application provisions project resources',
      detail: 'Provisioning includes documents, boards, team metadata, and generated starter content.',
    },
    {
      id: 's6',
      label: 'User lands in dashboard with next action highlighted',
      detail: 'The final node verifies that wrapped rows still connect cleanly and do not overlap earlier nodes.',
    },
    {
      id: 's7',
      label: 'Team reviews the generated workspace activity summary',
      detail: 'The seventh node keeps the smoke case above the compact single-row threshold.',
    },
  ],
  [
    { from: 's1', to: 's2', label: 'begin' },
    { from: 's2', to: 's3', label: 'continue' },
    { from: 's3', to: 's4', label: 'approve' },
    { from: 's4', to: 's5', label: 'provision' },
    { from: 's5', to: 's6', label: 'complete' },
    { from: 's6', to: 's7', label: 'review' },
    { from: 's1', to: 's4', label: 'skip ahead' },
    { from: 's4', to: 's1', label: 'revise' },
    { from: 's2', to: 's6', label: 'policy signal' },
    { from: 's7', to: 's3', label: 'feedback' },
    { from: 's1', to: 's7', label: 'audit' },
  ]
)
const promptStore = await loadBoard(promptBoardName, boardRoot)
const promptDiagram = appendWorkflowDiagram(promptStore, promptWorkflow)
const promptBoardPath = await saveBoard(promptBoardName, promptStore, boardRoot)
const promptPreviewPath = resolveSvgPath(promptBoardName, boardRoot)
const promptSummary = await summarizeBoard(promptBoardName, boardRoot)
const promptRaw = JSON.parse(await fs.readFile(promptBoardPath, 'utf8')) as { records?: unknown[] }

try {
  buildPromptWorkflow('Invalid prompt workflow', boardRoot, [{ id: 'known', label: 'Known' }], [
    { from: 'known', to: 'missing' },
  ])
  throw new Error('Expected prompt workflow validation to reject unknown connection references.')
} catch (error) {
  if (!String((error as Error).message).includes('unknown to step')) throw error
}

try {
  buildPromptWorkflow('   ', boardRoot, [{ label: 'Known' }])
  throw new Error('Expected prompt workflow validation to reject empty titles.')
} catch (error) {
  if (!String((error as Error).message).includes('title cannot be empty')) throw error
}

if (!Array.isArray(raw.records)) throw new Error('Smoke board did not write a tldraw records array.')
if (!Array.isArray(promptRaw.records)) throw new Error('Prompt smoke board did not write a tldraw records array.')
if (!firstPreview.startsWith('<?xml') || !firstPreview.includes('<svg') || !firstPreview.includes('<rect')) {
  throw new Error('Board save did not create a valid SVG preview.')
}
if (firstPreview === secondPreview) throw new Error('Appending a diagram did not refresh the SVG preview.')
if (summary.svgPath !== previewPath) throw new Error('Board summary did not return the SVG preview path.')
const promptPreview = await fs.readFile(promptPreviewPath, 'utf8')
if (!promptPreview.includes('Visual stress &amp; workflow')) throw new Error('SVG preview did not escape label text.')
if (summary.diagrams.length !== 2) throw new Error(`Expected 2 diagrams, found ${summary.diagrams.length}.`)
if (!second.appended) throw new Error('Second diagram was not marked as appended.')
if (promptWorkflow.connections.length !== 11) throw new Error('Prompt workflow did not retain dense connections.')
if (promptSummary.diagrams.length !== 1) throw new Error(`Expected 1 prompt diagram, found ${promptSummary.diagrams.length}.`)
assertNoStepOverlaps(raw.records)
assertNoStepOverlaps(promptRaw.records)
assertNoDiagramStepBoundsOverlap(raw.records)
assertWrappedRows(promptRaw.records, promptDiagram.diagramId)
assertAdaptiveStepHeight(promptRaw.records, promptDiagram.diagramId)
assertTextFits(promptRaw.records, promptDiagram.diagramId)
assertConnectionRouting(promptRaw.records, promptDiagram.diagramId)

console.log(
  JSON.stringify(
    {
      boardName,
      boardPath,
      previewPath,
      firstDiagram: first.diagramId,
      secondDiagram: second.diagramId,
      promptBoardPath,
      promptDiagram: promptDiagram.diagramId,
      shapeCount: summary.shapeCount,
      promptShapeCount: promptSummary.shapeCount,
      records: raw.records.length,
    },
    null,
    2
  )
)

if (!process.env.TLDRAW_MCP_KEEP_SMOKE_BOARD) {
  await fs.rm(boardPath, { force: true })
  await fs.rm(previewPath, { force: true })
  await fs.rm(promptBoardPath, { force: true })
  await fs.rm(promptPreviewPath, { force: true })
}

process.exit(0)

type RawShape = {
  typeName?: string
  type?: string
  x?: number
  y?: number
  props?: {
    w?: number
    h?: number
    end?: { x: number; y: number }
    arrowheadEnd?: string
    richText?: unknown
  }
  meta?: {
    tldrawMcp?: {
      diagramId?: string
      kind?: string
      connectionIndex?: number
      segmentIndex?: number
    }
  }
}

function assertSequentialConnections(workflow: ProductWorkflow, label: string) {
  const expectedCount = Math.max(0, workflow.steps.length - 1)
  if (workflow.connections.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} sequential connections for ${label}, found ${workflow.connections.length}.`)
  }

  for (let index = 0; index < workflow.connections.length; index += 1) {
    const connection = workflow.connections[index]
    const from = workflow.steps[index]
    const to = workflow.steps[index + 1]
    if (connection.from !== from.id || connection.to !== to.id || connection.label !== '') {
      throw new Error(`Unexpected sequential connection ${index + 1} for ${label}.`)
    }
  }
}

function assertNoStepOverlaps(records: unknown[]) {
  const byDiagram = new Map<string, RawShape[]>()
  for (const shape of stepShapes(records)) {
    const diagramId = shape.meta?.tldrawMcp?.diagramId
    if (!diagramId) continue
    const shapes = byDiagram.get(diagramId) ?? []
    shapes.push(shape)
    byDiagram.set(diagramId, shapes)
  }

  for (const [diagramId, shapes] of byDiagram) {
    for (let index = 0; index < shapes.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < shapes.length; nextIndex += 1) {
        if (overlaps(shapes[index], shapes[nextIndex])) {
          throw new Error(`Step shapes overlap in diagram ${diagramId}: ${index + 1} and ${nextIndex + 1}`)
        }
      }
    }
  }
}

function assertNoDiagramStepBoundsOverlap(records: unknown[]) {
  const boundsByDiagram = new Map<string, RawShape>()
  for (const shape of stepShapes(records)) {
    const diagramId = shape.meta?.tldrawMcp?.diagramId
    if (!diagramId) continue
    const existing = boundsByDiagram.get(diagramId)
    boundsByDiagram.set(diagramId, existing ? combineBounds(existing, shape) : shape)
  }

  const entries = [...boundsByDiagram.entries()]
  for (let index = 0; index < entries.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < entries.length; nextIndex += 1) {
      if (overlaps(entries[index][1], entries[nextIndex][1])) {
        throw new Error(`Appended diagram step bounds overlap: ${entries[index][0]} and ${entries[nextIndex][0]}`)
      }
    }
  }
}

function assertWrappedRows(records: unknown[], diagramId: string) {
  const rows = new Set(stepShapes(records, diagramId).map((shape) => shape.y))
  if (rows.size < 2) throw new Error('Prompt workflow did not wrap long diagrams onto multiple rows.')
}

function assertAdaptiveStepHeight(records: unknown[], diagramId: string) {
  const hasTallStep = stepShapes(records, diagramId).some((shape) => typeof shape.props?.h === 'number' && shape.props.h > 120)
  if (!hasTallStep) throw new Error('Prompt workflow did not increase step height for long labels.')
}

function assertTextFits(records: unknown[], diagramId: string) {
  for (const shape of stepShapes(records, diagramId)) {
    const text = richTextToPlainText(shape.props?.richText)
    const lines = text.split('\n')
    if (lines.some((line) => line.length > 30)) {
      throw new Error('Prompt workflow rendered a line wider than the deterministic wrapping limit.')
    }
    if (lines.length * 26 + 56 > (shape.props?.h ?? 0)) {
      throw new Error('Prompt workflow rendered text taller than its step shape.')
    }
  }
}

function assertConnectionRouting(records: unknown[], diagramId: string) {
  const steps = stepShapes(records, diagramId)
  const connections = records.filter((record): record is RawShape => {
    const shape = record as RawShape
    return (
      shape.typeName === 'shape' &&
      shape.type === 'arrow' &&
      shape.meta?.tldrawMcp?.diagramId === diagramId &&
      shape.meta.tldrawMcp.kind === 'connection' &&
      typeof shape.x === 'number' &&
      typeof shape.y === 'number' &&
      typeof shape.props?.end?.x === 'number' &&
      typeof shape.props.end.y === 'number'
    )
  })

  const byConnection = new Map<number, RawShape[]>()
  const tracks = new Set<string>()
  for (const connection of connections) {
    const connectionIndex = connection.meta?.tldrawMcp?.connectionIndex
    if (connectionIndex === undefined) throw new Error('Connection segment is missing its routing identity.')
    const segments = byConnection.get(connectionIndex) ?? []
    segments.push(connection)
    byConnection.set(connectionIndex, segments)

    const start = { x: connection.x ?? 0, y: connection.y ?? 0 }
    const end = {
      x: start.x + (connection.props?.end?.x ?? 0),
      y: start.y + (connection.props?.end?.y ?? 0),
    }
    if (start.x !== end.x && start.y !== end.y) throw new Error('Connection routing produced a diagonal segment.')
    const track = [pointKey(start), pointKey(end)].sort().join('|')
    if (tracks.has(track)) throw new Error(`Connection routing reused an existing track: ${track}`)
    tracks.add(track)
    const labelLines = richTextToPlainText(connection.props?.richText).split('\n')
    if (labelLines.some((line) => line.length > 24)) {
      throw new Error('Connection routing rendered a label wider than its wrapping limit.')
    }
    if (steps.some((step) => segmentCrossesStepInterior(start, end, step))) {
      throw new Error(`Connection segment crosses a workflow step: ${track}`)
    }
  }

  if (byConnection.size !== 11) throw new Error(`Expected 11 routed connections, found ${byConnection.size}.`)
  for (const [connectionIndex, segments] of byConnection) {
    const arrowheads = segments.filter((segment) => segment.props?.arrowheadEnd === 'arrow')
    if (arrowheads.length !== 1) {
      throw new Error(`Connection ${connectionIndex} must have exactly one final arrowhead.`)
    }
  }
}

function segmentCrossesStepInterior(start: { x: number; y: number }, end: { x: number; y: number }, step: RawShape) {
  const left = step.x ?? 0
  const top = step.y ?? 0
  const right = left + (step.props?.w ?? 0)
  const bottom = top + (step.props?.h ?? 0)
  if (start.x === end.x) {
    return start.x > left && start.x < right && Math.max(Math.min(start.y, end.y), top) < Math.min(Math.max(start.y, end.y), bottom)
  }
  return start.y > top && start.y < bottom && Math.max(Math.min(start.x, end.x), left) < Math.min(Math.max(start.x, end.x), right)
}

function pointKey(point: { x: number; y: number }) {
  return `${point.x},${point.y}`
}

function richTextToPlainText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: string; content?: unknown[]; type?: string }
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  const separator = node.type === 'doc' ? '\n' : ''
  return node.content.map(richTextToPlainText).join(separator)
}

function stepShapes(records: unknown[], diagramId?: string) {
  return records.filter((record): record is RawShape => {
    const shape = record as RawShape
    return (
      shape.typeName === 'shape' &&
      shape.type === 'geo' &&
      shape.meta?.tldrawMcp?.kind === 'step' &&
      (!diagramId || shape.meta.tldrawMcp.diagramId === diagramId) &&
      typeof shape.x === 'number' &&
      typeof shape.y === 'number' &&
      typeof shape.props?.w === 'number' &&
      typeof shape.props.h === 'number'
    )
  })
}

function combineBounds(a: RawShape, b: RawShape): RawShape {
  const minX = Math.min(a.x ?? 0, b.x ?? 0)
  const minY = Math.min(a.y ?? 0, b.y ?? 0)
  const maxX = Math.max((a.x ?? 0) + (a.props?.w ?? 0), (b.x ?? 0) + (b.props?.w ?? 0))
  const maxY = Math.max((a.y ?? 0) + (a.props?.h ?? 0), (b.y ?? 0) + (b.props?.h ?? 0))
  return {
    x: minX,
    y: minY,
    props: {
      w: maxX - minX,
      h: maxY - minY,
    },
  }
}

function overlaps(a: RawShape, b: RawShape) {
  const aw = a.props?.w ?? 0
  const ah = a.props?.h ?? 0
  const bw = b.props?.w ?? 0
  const bh = b.props?.h ?? 0
  return (a.x ?? 0) < (b.x ?? 0) + bw && (a.x ?? 0) + aw > (b.x ?? 0) && (a.y ?? 0) < (b.y ?? 0) + bh && (a.y ?? 0) + ah > (b.y ?? 0)
}
