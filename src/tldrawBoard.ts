import fs from 'node:fs/promises'
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
import type {
  BoardSummary,
  CodeGraph,
  CodeGraphDriftResult,
  CodeGraphDriftStatus,
  CodeGraphElementKind,
  ProductWorkflow,
  StoredCodeGraph,
  WorkflowConnection,
  WorkflowStep,
} from './types.js'

type TldrawFile = {
  tldrawFileFormatVersion: 1
  schema: unknown
  records: Array<Record<string, unknown>>
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type Point = { x: number; y: number }
type StepLayout = { x: number; y: number; w: number; h: number; row: number; body: string }
type ShapeMetadata = {
  diagramId?: string
  diagramType?: string
  metadataVersion?: number
  repoName?: string
  repoPath?: string
  kind?: string
  elementKind?: CodeGraphElementKind
  elementId?: string
  fingerprint?: string
  driftStatus?: CodeGraphDriftStatus
  baseColor?: string
  baseDash?: string
}
type DiagramMetadataFactory = {
  title: () => Record<string, unknown>
  step: (step: WorkflowStep, stepIndex: number) => Record<string, unknown>
  connection: (
    connection: WorkflowConnection,
    connectionIndex: number,
    routeMetadata: Record<string, unknown>
  ) => Record<string, unknown>
}

const PAGE_ID = PageRecordType.createId('page')
const DIAGRAM_GAP = 260
const STEP_MIN_W = 320
const STEP_MAX_W = 440
const STEP_MIN_H = 120
const STEP_GAP_X = 260
const STEP_MIN_GAP_Y = 120
const STEP_COLUMNS = 4
const SINGLE_ROW_STEP_LIMIT = 6
const STEP_TEXT_LINE_HEIGHT = 26
const STEP_TEXT_PADDING_Y = 56
const STEP_TEXT_CHARS_PER_LINE = 30
const CONNECTION_LABEL_CHARS_PER_LINE = 24
const ROUTE_CLEARANCE = 32
const ROUTE_LANE_GAP = 32
const ROUTE_OUTER_GAP = 88
const CODE_GRAPH_METADATA_VERSION = 1

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
  const shapes = buildDiagramShapes(store, workflow, diagramId, offsetX, offsetY, workflowMetadata(workflow, diagramId))
  store.put(shapes)
  return {
    diagramId,
    shapeCount: shapes.length,
    appended: Boolean(existingBounds),
  }
}

export function appendCodeGraphDiagram(store: TLStore, graph: CodeGraph) {
  const existingBounds = getShapeBounds(store)
  const offsetX = existingBounds ? existingBounds.maxX + DIAGRAM_GAP : 0
  const offsetY = existingBounds ? existingBounds.minY : 0
  const diagramId = `code-graph-${Date.now().toString(36)}`
  const workflow = codeGraphWorkflow(graph)
  const shapes = buildDiagramShapes(store, workflow, diagramId, offsetX, offsetY, codeGraphMetadata(graph, diagramId))
  store.put(shapes)
  return {
    diagramId,
    shapeCount: shapes.length,
    appended: Boolean(existingBounds),
  }
}

export function readStoredCodeGraph(store: TLStore, requestedDiagramId?: string): StoredCodeGraph {
  const shapes = getShapes(store)
  const graphDiagramIds = shapes
    .map(readShapeMeta)
    .filter((meta): meta is ShapeMetadata & { diagramId: string } => Boolean(meta?.diagramId && meta.diagramType === 'code-graph'))
    .map((meta) => meta.diagramId)
  const diagramIds = [...new Set(graphDiagramIds)]

  if (diagramIds.length === 0) {
    throw new Error('This board has no trackable code graph. Create one with diagram_code_graph before comparing drift.')
  }

  const diagramId = requestedDiagramId ?? diagramIds.at(-1)
  if (!diagramId || !diagramIds.includes(diagramId)) {
    throw new Error(`Code graph diagram "${requestedDiagramId}" was not found on this board.`)
  }

  const elements = new Map<string, StoredCodeGraph['elements'][number]>()
  for (const shape of shapes) {
    const meta = readShapeMeta(shape)
    if (meta?.diagramId !== diagramId || meta.diagramType !== 'code-graph') continue
    if (meta.metadataVersion !== CODE_GRAPH_METADATA_VERSION) {
      throw new Error(
        `Code graph diagram "${diagramId}" uses unsupported metadata version ${meta.metadataVersion ?? 'missing'}.`
      )
    }
    if (meta.kind === 'title') continue
    if (!meta.elementKind || !meta.elementId || !meta.fingerprint) {
      throw new Error(`Code graph diagram "${diagramId}" has incomplete metadata on shape ${shape.id}.`)
    }
    const element = { kind: meta.elementKind, id: meta.elementId, fingerprint: meta.fingerprint }
    const key = `${element.kind}:${element.id}`
    const existing = elements.get(key)
    if (existing && existing.fingerprint !== element.fingerprint) {
      throw new Error(`Code graph diagram "${diagramId}" has conflicting metadata for ${key}.`)
    }
    elements.set(key, element)
  }

  if (elements.size === 0) throw new Error(`Code graph diagram "${diagramId}" has no trackable elements.`)
  return { diagramId, elements: [...elements.values()] }
}

export function applyCodeGraphDrift(store: TLStore, drift: CodeGraphDriftResult) {
  const statuses = new Map<string, Exclude<CodeGraphDriftStatus, 'new'>>()
  for (const element of drift.elements) {
    if (element.status !== 'new') statuses.set(`${element.kind}:${element.id}`, element.status)
  }
  const updates: TLShape[] = []

  for (const shape of getShapes(store)) {
    const meta = readShapeMeta(shape)
    if (
      meta?.diagramId !== drift.diagramId ||
      !meta.elementKind ||
      !meta.elementId ||
      !('color' in shape.props) ||
      !('dash' in shape.props)
    ) {
      continue
    }

    const status = statuses.get(`${meta.elementKind}:${meta.elementId}`)
    if (!status) continue
    const currentColor = String(shape.props.color)
    const currentDash = String(shape.props.dash)
    const baseColor = meta.driftStatus === 'unchanged' ? currentColor : (meta.baseColor ?? currentColor)
    const baseDash = meta.driftStatus === 'unchanged' ? currentDash : (meta.baseDash ?? currentDash)
    const style = driftStyle(status, baseColor, baseDash)

    if (
      meta.driftStatus === status &&
      meta.baseColor === baseColor &&
      meta.baseDash === baseDash &&
      currentColor === style.color &&
      currentDash === style.dash
    ) {
      continue
    }

    updates.push({
      ...shape,
      props: { ...shape.props, color: style.color, dash: style.dash },
      meta: {
        ...shape.meta,
        tldrawMcp: {
          ...(shape.meta.tldrawMcp as Record<string, unknown>),
          driftStatus: status,
          baseColor,
          baseDash,
        },
      },
    } as TLShape)
  }

  if (updates.length > 0) store.put(updates)
  return updates.length
}

export async function summarizeBoard(name = 'main', root?: string): Promise<BoardSummary> {
  const store = await loadBoard(name, root)
  const shapes = getShapes(store)
  const shapesByType: Record<string, number> = {}
  const diagrams = new Map<
    string,
    {
      repoName?: string
      repoPath?: string
      diagramType?: string
      labels: string[]
      shapeCount: number
      driftElementStatuses: Map<string, CodeGraphDriftStatus>
    }
  >()

  for (const shape of shapes) {
    shapesByType[shape.type] = (shapesByType[shape.type] ?? 0) + 1
    const meta = readShapeMeta(shape)
    if (meta?.diagramId) {
      const entry = diagrams.get(meta.diagramId) ?? {
        repoName: meta.repoName,
        repoPath: meta.repoPath,
        diagramType: meta.diagramType,
        labels: [] as string[],
        shapeCount: 0,
        driftElementStatuses: new Map<string, CodeGraphDriftStatus>(),
      }
      entry.shapeCount += 1
      if (meta.driftStatus && meta.elementId && meta.elementKind) {
        entry.driftElementStatuses.set(`${meta.elementKind}:${meta.elementId}`, meta.driftStatus)
      }
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
      diagramType: entry.diagramType,
      repoName: entry.repoName,
      repoPath: entry.repoPath,
      shapeCount: entry.shapeCount,
      labels: entry.labels.slice(0, 20),
      driftStatusCounts: summarizeDriftStatuses(entry.driftElementStatuses),
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
  offsetY: number,
  metadata: DiagramMetadataFactory
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
      meta: metadata.title(),
    }) as TLShape
  )

  const positions = layoutSteps(workflow.steps, workflow.connections, offsetX, offsetY + 100)
  for (const [stepIndex, workflowStep] of workflow.steps.entries()) {
    const position = positions.get(workflowStep.id)
    if (!position) continue
    records.push(createStepShape(store, workflowStep, diagramId, position, stepIndex, index++, metadata))
  }

  const routes = routeConnections(workflow.connections, positions)
  for (const route of routes) {
    const labelSegment = longestHorizontalSegment(route.points)
    for (let segmentIndex = 0; segmentIndex < route.points.length - 1; segmentIndex += 1) {
      const start = route.points[segmentIndex]
      const end = route.points[segmentIndex + 1]
      if (start.x === end.x && start.y === end.y) continue
      const isLast = segmentIndex === route.points.length - 2
      const label = segmentIndex === labelSegment ? wrapText(route.connection.label, CONNECTION_LABEL_CHARS_PER_LINE) : ''
      records.push(
        store.schema.types.shape.create({
          id: createShapeId(
            `${diagramId}-arrow-${route.connection.from}-${route.connection.to}-${route.connectionIndex}-${segmentIndex}`
          ),
          type: 'arrow',
          parentId: PAGE_ID,
          index: indexKey(index++),
          x: start.x,
          y: start.y,
          props: {
            kind: 'arc',
            labelColor: 'black',
            color: 'black',
            fill: 'none',
            dash: 'solid',
            size: 's',
            arrowheadStart: 'none',
            arrowheadEnd: isLast ? 'arrow' : 'none',
            font: 'sans',
            start: { x: 0, y: 0 },
            end: { x: end.x - start.x, y: end.y - start.y },
            bend: 0,
            richText: toRichText(label),
            labelPosition: 0.5,
            scale: 1,
            elbowMidPoint: 0.5,
          },
          meta: metadata.connection(route.connection, route.connectionIndex, {
            connectionIndex: route.connectionIndex,
            segmentIndex,
            segmentCount: route.points.length - 1,
          }),
        }) as TLShape
      )
    }
  }

  return records
}

function createStepShape(
  store: TLStore,
  workflowStep: WorkflowStep,
  diagramId: string,
  layout: StepLayout,
  stepIndex: number,
  index: number,
  metadata: DiagramMetadataFactory
) {
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
      richText: toRichText(layout.body),
    },
    meta: metadata.step(workflowStep, stepIndex),
  }) as TLShape
}

function layoutSteps(steps: WorkflowStep[], connections: WorkflowConnection[], offsetX: number, offsetY: number) {
  const positions = new Map<string, StepLayout>()
  const rows: Array<{ steps: Array<{ step: WorkflowStep; size: { w: number; h: number; body: string } }>; height: number }> = []
  const columns = columnsForStepCount(steps.length)
  const rowByStep = new Map(steps.map((step, index) => [step.id, Math.floor(index / columns)]))
  const gapLaneDemand = connectionLaneDemand(connections, rowByStep)

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
        body: size.body,
      })
    })
    const laneCount = gapLaneDemand.get(rowIndex) ?? 0
    y += row.height + Math.max(STEP_MIN_GAP_Y, ROUTE_CLEARANCE * 2 + laneCount * ROUTE_LANE_GAP)
  })

  return positions
}

function measureStep(step: WorkflowStep) {
  const body = step.detail ? `${step.label}\n${step.detail}` : step.label
  const longestWord = body.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 0)
  const w = clamp(STEP_MIN_W + Math.max(0, longestWord - 18) * 8, STEP_MIN_W, STEP_MAX_W)
  const charsPerLine = Math.max(20, Math.floor((w - 48) / 10))
  const wrappedBody = wrapText(body, Math.min(charsPerLine, STEP_TEXT_CHARS_PER_LINE))
  const lineCount = wrappedBody.split('\n').length
  return {
    w,
    h: Math.max(STEP_MIN_H, lineCount * STEP_TEXT_LINE_HEIGHT + STEP_TEXT_PADDING_Y),
    body: wrappedBody,
  }
}

function columnsForStepCount(stepCount: number) {
  return stepCount <= SINGLE_ROW_STEP_LIMIT ? Math.max(1, stepCount) : STEP_COLUMNS
}

function diagramWidth(stepCount: number) {
  const columns = columnsForStepCount(stepCount)
  return columns * STEP_MAX_W + Math.max(0, columns - 1) * STEP_GAP_X
}

function wrapText(text: string, maxLineLength: number) {
  return text
    .split('\n')
    .flatMap((line) => wrapLine(line.trim(), maxLineLength))
    .join('\n')
}

function wrapLine(line: string, maxLineLength: number) {
  if (!line) return ['']
  const lines: string[] = []
  let current = ''
  const words = line.split(/\s+/).flatMap((word) => {
    if (word.length <= maxLineLength) return [word]
    const chunks: string[] = []
    for (let index = 0; index < word.length; index += maxLineLength) {
      chunks.push(word.slice(index, index + maxLineLength))
    }
    return chunks
  })
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && candidate.length > maxLineLength) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  lines.push(current)
  return lines
}

function connectionLaneDemand(connections: WorkflowConnection[], rowByStep: Map<string, number>) {
  const demand = new Map<number, number>()
  for (const connection of connections) {
    const fromRow = rowByStep.get(connection.from)
    const toRow = rowByStep.get(connection.to)
    if (fromRow === undefined || toRow === undefined) continue
    if (fromRow === toRow) {
      demand.set(fromRow, (demand.get(fromRow) ?? 0) + 1)
      continue
    }
    const sourceGap = toRow > fromRow ? fromRow : fromRow - 1
    const targetGap = toRow > fromRow ? toRow - 1 : toRow
    demand.set(sourceGap, (demand.get(sourceGap) ?? 0) + 1)
    if (targetGap !== sourceGap) demand.set(targetGap, (demand.get(targetGap) ?? 0) + 1)
  }
  return demand
}

function routeConnections(connections: WorkflowConnection[], positions: Map<string, StepLayout>) {
  const layouts = [...positions.values()]
  const rowBounds = new Map<number, { top: number; bottom: number }>()
  for (const layout of layouts) {
    const bounds = rowBounds.get(layout.row) ?? { top: layout.y, bottom: layout.y + layout.h }
    bounds.top = Math.min(bounds.top, layout.y)
    bounds.bottom = Math.max(bounds.bottom, layout.y + layout.h)
    rowBounds.set(layout.row, bounds)
  }

  const laneUse = new Map<number, number>()
  const portUse = new Map<string, number>()
  let outerLane = 0
  const maxBoxX = Math.max(...layouts.map((layout) => layout.x + layout.w))
  const pairCounts = new Map<string, number>()
  for (const connection of connections) {
    const pair = [connection.from, connection.to].sort().join(':')
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
  }

  const takeLane = (gap: number) => {
    const rank = laneUse.get(gap) ?? 0
    laneUse.set(gap, rank + 1)
    const top = (rowBounds.get(gap)?.bottom ?? rowBounds.get(gap + 1)?.top ?? 0) + ROUTE_CLEARANCE
    return top + rank * ROUTE_LANE_GAP
  }

  const takePort = (stepId: string, side: 'top' | 'bottom', layout: StepLayout): Point => {
    const key = `${stepId}:${side}`
    const rank = portUse.get(key) ?? 0
    portUse.set(key, rank + 1)
    const magnitude = Math.ceil(rank / 2) * 22
    const direction = rank % 2 === 1 ? 1 : -1
    const offset = rank === 0 ? 0 : direction * magnitude
    return {
      x: layout.x + layout.w / 2 + clamp(offset, -layout.w / 2 + 28, layout.w / 2 - 28),
      y: side === 'top' ? layout.y : layout.y + layout.h,
    }
  }

  return connections.flatMap((connection, connectionIndex) => {
    const from = positions.get(connection.from)
    const to = positions.get(connection.to)
    if (!from || !to) return []

    const pair = [connection.from, connection.to].sort().join(':')
    if (from.row === to.row && pairCounts.get(pair) === 1 && !hasIntermediateStep(from, to, layouts)) {
      const goesRight = to.x > from.x
      const start = { x: goesRight ? from.x + from.w : from.x, y: from.y + from.h / 2 }
      const end = { x: goesRight ? to.x : to.x + to.w, y: to.y + to.h / 2 }
      const channelX = start.x + (goesRight ? ROUTE_CLEARANCE : -ROUTE_CLEARANCE)
      return [{
        connection,
        connectionIndex,
        points: [start, { x: channelX, y: start.y }, { x: channelX, y: end.y }, end],
      }]
    }

    if (from.row === to.row) {
      const start = takePort(connection.from, 'bottom', from)
      const end = takePort(connection.to, 'bottom', to)
      const laneY = takeLane(from.row)
      return [{ connection, connectionIndex, points: [start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end] }]
    }

    const goesDown = to.row > from.row
    const sourceSide = goesDown ? 'bottom' : 'top'
    const targetSide = goesDown ? 'top' : 'bottom'
    const sourceGap = goesDown ? from.row : from.row - 1
    const targetGap = goesDown ? to.row - 1 : to.row
    const start = takePort(connection.from, sourceSide, from)
    const end = takePort(connection.to, targetSide, to)

    if (sourceGap === targetGap) {
      const laneY = takeLane(sourceGap)
      return [{ connection, connectionIndex, points: [start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end] }]
    }

    const sourceLaneY = takeLane(sourceGap)
    const targetLaneY = takeLane(targetGap)
    const laneX = maxBoxX + ROUTE_OUTER_GAP + outerLane++ * ROUTE_LANE_GAP
    return [{
      connection,
      connectionIndex,
      points: [
        start,
        { x: start.x, y: sourceLaneY },
        { x: laneX, y: sourceLaneY },
        { x: laneX, y: targetLaneY },
        { x: end.x, y: targetLaneY },
        end,
      ],
    }]
  })
}

function hasIntermediateStep(from: StepLayout, to: StepLayout, layouts: StepLayout[]) {
  const minX = Math.min(from.x, to.x)
  const maxX = Math.max(from.x, to.x)
  return layouts.some((layout) => layout.row === from.row && layout !== from && layout !== to && layout.x > minX && layout.x < maxX)
}

function longestHorizontalSegment(points: Point[]) {
  let longestIndex = 0
  let longestLength = -1
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = points[index].y === points[index + 1].y ? Math.abs(points[index + 1].x - points[index].x) : -1
    if (length > longestLength) {
      longestLength = length
      longestIndex = index
    }
  }
  return longestIndex
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
  return meta as ShapeMetadata
}

function workflowMetadata(workflow: ProductWorkflow, diagramId: string): DiagramMetadataFactory {
  const meta = (kind: string, evidence: string[], extra: Record<string, unknown> = {}) => ({
    tldrawMcp: { diagramId, repoName: workflow.repoName, kind, evidence, ...extra },
  })
  return {
    title: () => meta('title', []),
    step: (step) => meta('step', step.evidence),
    connection: (_connection, _connectionIndex, routeMetadata) => meta('connection', [], routeMetadata),
  }
}

function codeGraphWorkflow(graph: CodeGraph): ProductWorkflow {
  return {
    repoName: `${graph.repoName} code graph`,
    repoPath: graph.repoPath,
    steps: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      detail: node.localImportCount === 1 ? '1 local import' : `${node.localImportCount} local imports`,
      evidence: [node.sourcePath],
    })),
    connections: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.kind === 'import' ? '' : edge.kind.replace('-', ' '),
    })),
  }
}

function codeGraphMetadata(graph: CodeGraph, diagramId: string): DiagramMetadataFactory {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  return {
    title: () => ({
      tldrawMcp: {
        diagramId,
        diagramType: 'code-graph',
        metadataVersion: CODE_GRAPH_METADATA_VERSION,
        repoName: graph.repoName,
        kind: 'title',
      },
    }),
    step: (step, stepIndex) => {
      const node = nodeById.get(step.id)
      if (!node) throw new Error(`Code graph node metadata is missing for ${step.id}.`)
      return {
        tldrawMcp: {
          diagramId,
          diagramType: 'code-graph',
          metadataVersion: CODE_GRAPH_METADATA_VERSION,
          repoName: graph.repoName,
          kind: 'step',
          elementKind: 'node',
          elementId: node.id,
          fingerprint: node.fingerprint,
          sourcePaths: [node.sourcePath],
          driftStatus: 'unchanged',
          baseColor: colorForStep(stepIndex),
          baseDash: 'solid',
        },
      }
    },
    connection: (_connection, connectionIndex, routeMetadata) => {
      const edge = graph.edges[connectionIndex]
      if (!edge) throw new Error(`Code graph edge metadata is missing at index ${connectionIndex}.`)
      return {
        tldrawMcp: {
          diagramId,
          diagramType: 'code-graph',
          metadataVersion: CODE_GRAPH_METADATA_VERSION,
          repoName: graph.repoName,
          kind: 'connection',
          elementKind: 'edge',
          elementId: edge.id,
          fingerprint: edge.fingerprint,
          sourcePaths: [edge.from, edge.to],
          driftStatus: 'unchanged',
          baseColor: 'black',
          baseDash: 'solid',
          ...routeMetadata,
        },
      }
    },
  }
}

function driftStyle(status: Exclude<CodeGraphDriftStatus, 'new'>, baseColor: string, baseDash: string) {
  if (status === 'stale') return { color: 'red', dash: 'dashed' }
  if (status === 'changed') return { color: 'orange', dash: 'dashed' }
  return { color: baseColor, dash: baseDash }
}

function summarizeDriftStatuses(statuses: Map<string, CodeGraphDriftStatus>) {
  if (statuses.size === 0) return undefined
  const counts: Partial<Record<CodeGraphDriftStatus, number>> = {}
  for (const status of statuses.values()) counts[status] = (counts[status] ?? 0) + 1
  return counts
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
