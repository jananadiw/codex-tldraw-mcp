import fs from 'node:fs/promises'
import { appendWorkflowDiagram, loadBoard, saveBoard, summarizeBoard } from '../src/tldrawBoard.js'
import { scanRepo } from '../src/repoScanner.js'
import { buildPromptWorkflow } from '../src/promptWorkflow.js'

const boardName = `smoke-${Date.now().toString(36)}`
const promptBoardName = `${boardName}-prompt`
const workflow = await scanRepo(process.cwd())
const boardRoot = workflow.repoPath

const firstStore = await loadBoard(boardName, boardRoot)
const first = appendWorkflowDiagram(firstStore, workflow)
await saveBoard(boardName, firstStore, boardRoot)

const secondStore = await loadBoard(boardName, boardRoot)
const second = appendWorkflowDiagram(secondStore, workflow)
const boardPath = await saveBoard(boardName, secondStore, boardRoot)

const summary = await summarizeBoard(boardName, boardRoot)
const raw = JSON.parse(await fs.readFile(boardPath, 'utf8')) as { records?: unknown[] }
const promptWorkflow = buildPromptWorkflow(
  'Visual stress workflow',
  boardRoot,
  [
    {
      label: 'Visitor opens a complex onboarding checklist',
      detail: 'The first screen includes guidance, requirements, and status text that must stay readable inside the node.',
    },
    {
      label: 'User chooses email, SSO, or invite-link authentication',
      detail: 'Different paths are represented as a single workflow step so the diagram renderer must allow wrapping.',
    },
    {
      label: 'System validates organization policy and account eligibility',
      detail: 'Longer implementation details should increase the step height instead of spilling into nearby shapes.',
    },
    {
      label: 'User completes profile and accepts workspace defaults',
      detail: 'The fourth step forces the next step onto a new row in the generated board layout.',
    },
    {
      label: 'Application provisions project resources',
      detail: 'Provisioning includes documents, boards, team metadata, and generated starter content.',
    },
    {
      label: 'User lands in dashboard with next action highlighted',
      detail: 'The final node verifies that wrapped rows still connect cleanly and do not overlap earlier nodes.',
    },
    {
      label: 'Team reviews the generated workspace activity summary',
      detail: 'The seventh node keeps the smoke case above the compact single-row threshold.',
    },
  ]
)
const promptStore = await loadBoard(promptBoardName, boardRoot)
const promptDiagram = appendWorkflowDiagram(promptStore, promptWorkflow)
const promptBoardPath = await saveBoard(promptBoardName, promptStore, boardRoot)
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
if (summary.diagrams.length !== 2) throw new Error(`Expected 2 diagrams, found ${summary.diagrams.length}.`)
if (!second.appended) throw new Error('Second diagram was not marked as appended.')
if (promptWorkflow.connections.length !== 6) throw new Error('Prompt workflow did not create sequential connections.')
if (promptSummary.diagrams.length !== 1) throw new Error(`Expected 1 prompt diagram, found ${promptSummary.diagrams.length}.`)
assertNoStepOverlaps(raw.records)
assertNoStepOverlaps(promptRaw.records)
assertNoDiagramStepBoundsOverlap(raw.records)
assertWrappedRows(promptRaw.records, promptDiagram.diagramId)
assertAdaptiveStepHeight(promptRaw.records, promptDiagram.diagramId)

console.log(
  JSON.stringify(
    {
      boardName,
      boardPath,
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
  await fs.rm(promptBoardPath, { force: true })
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
  }
  meta?: {
    tldrawMcp?: {
      diagramId?: string
      kind?: string
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
