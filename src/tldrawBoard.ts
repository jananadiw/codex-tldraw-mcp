import fs from 'node:fs/promises'
import './webCrypto.js'
import {
  CameraRecordType,
  createShapeId,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  DocumentRecordType,
  getIndexAbove,
  InstancePageStateRecordType,
  PageRecordType,
  PointerRecordType,
  TLDOCUMENT_ID,
  TLINSTANCE_ID,
  TLShape,
  TLStore,
  toRichText,
} from 'tldraw'
import { boardPath, boardsDir } from './paths.js'
import type { BoardSummary, ProductWorkflow, WorkflowStep } from './types.js'

type TldrawFile = {
  tldrawFileFormatVersion: 1
  schema: unknown
  records: Array<Record<string, unknown>>
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type StepLayout = { x: number; y: number; w: number; h: number; row: number }

const PAGE_ID = PageRecordType.createId('page')
const DIAGRAM_GAP = 260
const STEP_MIN_W = 280
const STEP_MAX_W = 380
const STEP_MIN_H = 120
const STEP_GAP_X = 120
const STEP_GAP_Y = 96
const STEP_COLUMNS = 4
const SINGLE_ROW_STEP_LIMIT = 6
const STEP_TEXT_LINE_HEIGHT = 24
const STEP_TEXT_PADDING_Y = 52
const STEP_TEXT_CHARS_PER_LINE = 34

export async function listBoardNames(root?: string) {
  try {
    const entries = await fs.readdir(boardsDir(root))
    return entries.filter((entry) => entry.endsWith('.tldr')).map((entry) => entry.slice(0, -5)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
}

export async function loadBoard(name = 'main', root?: string) {
  const filePath = boardPath(name, root)
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf8')) as TldrawFile
    const records = Object.fromEntries(data.records.map((record) => [String(record.id), record]))
    return createTLStore({
      shapeUtils: defaultShapeUtils,
      bindingUtils: defaultBindingUtils,
      snapshot: { store: records, schema: data.schema } as never,
      defaultName: name,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return createEmptyBoard(name)
  }
}

export async function saveBoard(name: string, store: TLStore, root?: string) {
  await fs.mkdir(boardsDir(root), { recursive: true })
  const filePath = boardPath(name, root)
  const data: TldrawFile = {
    tldrawFileFormatVersion: 1,
    schema: store.schema.serialize(),
    records: store.allRecords() as unknown as Array<Record<string, unknown>>,
  }
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`)
  await fs.rename(tmpPath, filePath)
  return filePath
}

export function appendWorkflowDiagram(store: TLStore, workflow: ProductWorkflow) {
  const existingBounds = getShapeBounds(store)
  const offsetX = existingBounds ? existingBounds.maxX + DIAGRAM_GAP : 0
  const offsetY = existingBounds ? existingBounds.minY : 0
  const diagramId = `workflow-${Date.now().toString(36)}`
  const shapes = buildDiagramShapes(store, workflow, diagramId, offsetX, offsetY)
  store.put(shapes)
  return {
    diagramId,
    shapeCount: shapes.length,
    appended: Boolean(existingBounds),
  }
}

export async function summarizeBoard(name = 'main', root?: string): Promise<BoardSummary> {
  const store = await loadBoard(name, root)
  const shapes = getShapes(store)
  const shapesByType: Record<string, number> = {}
  const diagrams = new Map<string, { repoName?: string; repoPath?: string; labels: string[]; shapeCount: number }>()

  for (const shape of shapes) {
    shapesByType[shape.type] = (shapesByType[shape.type] ?? 0) + 1
    const meta = readShapeMeta(shape)
    if (meta?.diagramId) {
      const entry = diagrams.get(meta.diagramId) ?? {
        repoName: meta.repoName,
        repoPath: meta.repoPath,
        labels: [],
        shapeCount: 0,
      }
      entry.shapeCount += 1
      const label = getShapeText(shape)
      if (label) entry.labels.push(label)
      diagrams.set(meta.diagramId, entry)
    }
  }

  return {
    boardName: name,
    boardPath: boardPath(name, root),
    shapeCount: shapes.length,
    shapesByType,
    diagrams: [...diagrams.entries()].map(([diagramId, entry]) => ({
      diagramId,
      repoName: entry.repoName,
      repoPath: entry.repoPath,
      shapeCount: entry.shapeCount,
      labels: entry.labels.slice(0, 20),
    })),
  }
}

function createEmptyBoard(name: string) {
  const store = createTLStore({
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    defaultName: name,
  })

  store.put([
    DocumentRecordType.create({ id: TLDOCUMENT_ID, name }),
    PointerRecordType.create({}),
    PageRecordType.create({
      id: PAGE_ID,
      name: 'Page 1',
      index: 'a1' as never,
      meta: {},
    }),
    store.schema.types.instance.create({
      id: TLINSTANCE_ID,
      currentPageId: PAGE_ID,
      exportBackground: true,
    }),
    InstancePageStateRecordType.create({ pageId: PAGE_ID }),
    CameraRecordType.create({
      id: CameraRecordType.createId(PAGE_ID),
      x: 0,
      y: 0,
      z: 1,
      meta: {},
    }),
  ])

  return store
}

function buildDiagramShapes(
  store: TLStore,
  workflow: ProductWorkflow,
  diagramId: string,
  offsetX: number,
  offsetY: number
) {
  const records: TLShape[] = []
  let index = 1
  const titleId = createShapeId(`${diagramId}-title`)
  records.push(
    store.schema.types.shape.create({
      id: titleId,
      type: 'text',
      parentId: PAGE_ID,
      index: indexKey(index++),
      x: offsetX,
      y: offsetY,
      props: {
        color: 'black',
        size: 'xl',
        font: 'sans',
        textAlign: 'start',
        w: diagramWidth(workflow.steps.length),
        richText: toRichText(workflow.repoName),
        scale: 1,
        autoSize: false,
      },
      meta: metaFor(workflow, diagramId, 'title', []),
    }) as TLShape
  )

  const positions = layoutSteps(workflow.steps, offsetX, offsetY + 100)
  for (const [stepIndex, workflowStep] of workflow.steps.entries()) {
    const position = positions.get(workflowStep.id)
    if (!position) continue
    records.push(createStepShape(store, workflowStep, workflow, diagramId, position, stepIndex, index++))
  }

  for (const connection of workflow.connections) {
    const from = positions.get(connection.from)
    const to = positions.get(connection.to)
    if (!from || !to) continue
    const { start, end } = connectionPoints(from, to)
    records.push(
      store.schema.types.shape.create({
        id: createShapeId(`${diagramId}-arrow-${connection.from}-${connection.to}`),
        type: 'arrow',
        parentId: PAGE_ID,
        index: indexKey(index++),
        x: start.x,
        y: start.y,
        props: {
          kind: 'elbow',
          labelColor: 'black',
          color: 'black',
          fill: 'none',
          dash: 'solid',
          size: 'm',
          arrowheadStart: 'none',
          arrowheadEnd: 'arrow',
          font: 'sans',
          start: { x: 0, y: 0 },
          end: { x: end.x - start.x, y: end.y - start.y },
          bend: 0,
          richText: toRichText(connection.label),
          labelPosition: 0.5,
          scale: 1,
          elbowMidPoint: 0.5,
        },
        meta: metaFor(workflow, diagramId, 'connection', []),
      }) as TLShape
    )
  }

  return records
}

function createStepShape(
  store: TLStore,
  workflowStep: WorkflowStep,
  workflow: ProductWorkflow,
  diagramId: string,
  layout: StepLayout,
  stepIndex: number,
  index: number
) {
  const body = workflowStep.detail ? `${workflowStep.label}\n${workflowStep.detail}` : workflowStep.label
  return store.schema.types.shape.create({
    id: createShapeId(`${diagramId}-${workflowStep.id}`),
    type: 'geo',
    parentId: PAGE_ID,
    index: indexKey(index),
    x: layout.x,
    y: layout.y,
    props: {
      geo: 'rectangle',
      dash: 'solid',
      url: '',
      w: layout.w,
      h: layout.h,
      growY: 0,
      scale: 1,
      labelColor: 'black',
      color: colorForStep(stepIndex),
      fill: 'semi',
      size: 'm',
      font: 'sans',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(body),
    },
    meta: metaFor(workflow, diagramId, 'step', workflowStep.evidence),
  }) as TLShape
}

function layoutSteps(steps: WorkflowStep[], offsetX: number, offsetY: number) {
  const positions = new Map<string, StepLayout>()
  const rows: Array<{ steps: Array<{ step: WorkflowStep; size: { w: number; h: number } }>; height: number }> = []
  const columns = columnsForStepCount(steps.length)

  steps.forEach((step, stepIndex) => {
    const rowIndex = Math.floor(stepIndex / columns)
    const row = rows[rowIndex] ?? { steps: [], height: 0 }
    const size = measureStep(step)
    row.steps.push({ step, size })
    row.height = Math.max(row.height, size.h)
    rows[rowIndex] = row
  })

  let y = offsetY
  rows.forEach((row, rowIndex) => {
    row.steps.forEach(({ step, size }, columnIndex) => {
      positions.set(step.id, {
        x: offsetX + columnIndex * (STEP_MAX_W + STEP_GAP_X),
        y,
        w: size.w,
        h: size.h,
        row: rowIndex,
      })
    })
    y += row.height + STEP_GAP_Y
  })

  return positions
}

function measureStep(step: WorkflowStep) {
  const body = step.detail ? `${step.label}\n${step.detail}` : step.label
  const longestWord = body.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 0)
  const w = clamp(STEP_MIN_W + Math.max(0, longestWord - 18) * 7, STEP_MIN_W, STEP_MAX_W)
  const lineCount = estimateLineCount(body, STEP_TEXT_CHARS_PER_LINE)
  return {
    w,
    h: Math.max(STEP_MIN_H, lineCount * STEP_TEXT_LINE_HEIGHT + STEP_TEXT_PADDING_Y),
  }
}

function columnsForStepCount(stepCount: number) {
  return stepCount <= SINGLE_ROW_STEP_LIMIT ? Math.max(1, stepCount) : STEP_COLUMNS
}

function diagramWidth(stepCount: number) {
  const columns = columnsForStepCount(stepCount)
  return columns * STEP_MAX_W + Math.max(0, columns - 1) * STEP_GAP_X
}

function estimateLineCount(text: string, charsPerLine: number) {
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.trim().length / charsPerLine)), 0)
}

function connectionPoints(from: StepLayout, to: StepLayout) {
  if (from.row !== to.row) {
    return {
      start: { x: from.x + from.w / 2, y: from.y + from.h },
      end: { x: to.x + to.w / 2, y: to.y },
    }
  }

  if (to.x < from.x) {
    return {
      start: { x: from.x, y: from.y + from.h / 2 },
      end: { x: to.x + to.w, y: to.y + to.h / 2 },
    }
  }

  return {
    start: { x: from.x + from.w, y: from.y + from.h / 2 },
    end: { x: to.x, y: to.y + to.h / 2 },
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function getShapeBounds(store: TLStore): Bounds | null {
  const shapes = getShapes(store)
  if (shapes.length === 0) return null
  return shapes.reduce<Bounds>(
    (bounds, shape) => {
      const shapeBounds = getSingleShapeBounds(shape)
      return {
        minX: Math.min(bounds.minX, shapeBounds.minX),
        minY: Math.min(bounds.minY, shapeBounds.minY),
        maxX: Math.max(bounds.maxX, shapeBounds.maxX),
        maxY: Math.max(bounds.maxY, shapeBounds.maxY),
      }
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  )
}

function getSingleShapeBounds(shape: TLShape): Bounds {
  if (shape.type === 'arrow' && 'end' in shape.props) {
    const endX = shape.x + shape.props.end.x
    const endY = shape.y + shape.props.end.y
    return {
      minX: Math.min(shape.x, endX),
      minY: Math.min(shape.y, endY),
      maxX: Math.max(shape.x, endX),
      maxY: Math.max(shape.y, endY),
    }
  }

  const width = getShapeWidth(shape)
  const height = getShapeHeight(shape)
  return {
    minX: shape.x,
    minY: shape.y,
    maxX: shape.x + width,
    maxY: shape.y + height,
  }
}

function getShapes(store: TLStore) {
  return store.allRecords().filter((record): record is TLShape => record.typeName === 'shape')
}

function getShapeWidth(shape: TLShape) {
  if ('w' in shape.props && typeof shape.props.w === 'number') return shape.props.w
  if (shape.type === 'arrow' && 'end' in shape.props) return Math.max(1, Math.abs(shape.props.end.x))
  return STEP_MIN_W
}

function getShapeHeight(shape: TLShape) {
  if ('h' in shape.props && typeof shape.props.h === 'number') return shape.props.h
  if (shape.type === 'arrow' && 'end' in shape.props) return Math.max(1, Math.abs(shape.props.end.y))
  return STEP_MIN_H
}

function getShapeText(shape: TLShape) {
  if (!('richText' in shape.props)) return ''
  return richTextToPlainText(shape.props.richText)
}

function richTextToPlainText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: string; content?: unknown[] }
  if (typeof node.text === 'string') return node.text
  return Array.isArray(node.content) ? node.content.map(richTextToPlainText).join(' ').trim() : ''
}

function readShapeMeta(shape: TLShape) {
  const meta = shape.meta?.tldrawMcp
  if (!meta || typeof meta !== 'object') return null
  return meta as { diagramId?: string; repoName?: string; repoPath?: string }
}

function metaFor(workflow: ProductWorkflow, diagramId: string, kind: string, evidence: string[]) {
  return {
    tldrawMcp: {
      diagramId,
      repoName: workflow.repoName,
      kind,
      evidence,
    },
  }
}

function colorForStep(stepIndex: number) {
  const colors = ['blue', 'light-blue', 'violet', 'green', 'orange']
  return colors[stepIndex % colors.length]
}

function indexKey(index: number) {
  let key = null
  for (let i = 0; i < index; i += 1) {
    key = getIndexAbove(key)
  }
  return key
}
