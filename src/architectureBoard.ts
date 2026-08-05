import {
  createBindingId,
  createShapeId,
  getIndexAbove,
  PageRecordType,
  TLBinding,
  TLShape,
  TLShapeId,
  TLStore,
  toRichText,
} from 'tldraw'
import type { ArchitectureComponent, ArchitectureConnection, ArchitectureDiagram } from './types.js'

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type ComponentLayout = { x: number; y: number; w: number; h: number; role: 'primary' | 'support' }
type Anchor = { x: number; y: number }

const PAGE_ID = PageRecordType.createId('page')
const DIAGRAM_GAP = 260
const TITLE_H = 80
const COMPONENT_W = 320
const PRIMARY_GAP = 240
const SUPPORT_GAP = 80
const SUPPORT_ROW_GAP = 160
const COMPONENT_MIN_H = 150
const TEXT_LINE_H = 24
const TEXT_PADDING_Y = 56
const ARCHITECTURE_METADATA_VERSION = 2

export function appendArchitectureDiagram(store: TLStore, diagram: ArchitectureDiagram) {
  const existingBounds = getShapeBounds(store)
  const offsetX = existingBounds ? existingBounds.maxX + DIAGRAM_GAP : 0
  const offsetY = existingBounds ? existingBounds.minY : 0
  const diagramId = `architecture-${Date.now().toString(36)}`
  const records = buildArchitectureRecords(store, diagram, diagramId, offsetX, offsetY)
  store.put(records)
  return {
    diagramId,
    shapeCount: records.filter((record) => record.typeName === 'shape').length,
    bindingCount: records.filter((record) => record.typeName === 'binding').length,
    appended: Boolean(existingBounds),
  }
}

function buildArchitectureRecords(
  store: TLStore,
  diagram: ArchitectureDiagram,
  diagramId: string,
  offsetX: number,
  offsetY: number
) {
  const layouts = layoutComponents(diagram, offsetX, offsetY + TITLE_H + 20)
  const records: Array<TLShape | TLBinding> = []
  const shapeIds = new Map<string, TLShapeId>()
  let index = 1

  records.push(
    store.schema.types.shape.create({
      id: createShapeId(`${diagramId}-title`),
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
        w: diagramWidth(layouts, offsetX),
        richText: toRichText(diagram.title),
        scale: 1,
        autoSize: false,
      },
      meta: architectureMeta(diagramId, 'title'),
    }) as TLShape
  )

  for (const component of diagram.components) {
    const layout = requiredLayout(layouts, component.id)
    const shapeId = createShapeId(`${diagramId}-component-${component.id}`)
    shapeIds.set(component.id, shapeId)
    records.push(createComponentShape(store, diagramId, component, layout, shapeId, index++))
  }

  for (const [connectionIndex, connection] of diagram.connections.entries()) {
    const fromLayout = requiredLayout(layouts, connection.from)
    const toLayout = requiredLayout(layouts, connection.to)
    records.push(
      ...createConnectionRecords(
        store,
        diagramId,
        connection,
        connectionIndex,
        fromLayout,
        toLayout,
        connectionAnchors(connection, fromLayout, toLayout, diagram.connections, layouts),
        requiredShapeId(shapeIds, connection.from),
        requiredShapeId(shapeIds, connection.to),
        index++
      )
    )
  }

  return records
}

function layoutComponents(diagram: ArchitectureDiagram, offsetX: number, offsetY: number) {
  const components = new Map(diagram.components.map((component) => [component.id, component]))
  const layouts = new Map<string, ComponentLayout>()
  const primaryIds = new Set(diagram.primaryFlow)

  for (const [index, id] of diagram.primaryFlow.entries()) {
    const component = requiredComponent(components, id)
    layouts.set(id, {
      x: offsetX + index * (COMPONENT_W + PRIMARY_GAP),
      y: offsetY,
      w: COMPONENT_W,
      h: measureComponentHeight(component),
      role: 'primary',
    })
  }

  const primaryHeight = Math.max(...diagram.primaryFlow.map((id) => requiredLayout(layouts, id).h))
  const supportGroups = new Map<string, ArchitectureComponent[]>()
  for (const component of diagram.components.filter((candidate) => !primaryIds.has(candidate.id))) {
    const owner = findSupportOwner(component.id, diagram.connections, primaryIds) ?? diagram.primaryFlow[0]
    const group = supportGroups.get(owner) ?? []
    group.push(component)
    supportGroups.set(owner, group)
  }

  for (const [ownerId, group] of supportGroups) {
    const owner = requiredLayout(layouts, ownerId)
    const groupWidth = group.length * COMPONENT_W + Math.max(0, group.length - 1) * SUPPORT_GAP
    const startX = Math.max(offsetX, centerX(owner) - groupWidth / 2)
    for (const [index, component] of group.entries()) {
      layouts.set(component.id, {
        x: startX + index * (COMPONENT_W + SUPPORT_GAP),
        y: offsetY + primaryHeight + SUPPORT_ROW_GAP,
        w: COMPONENT_W,
        h: measureComponentHeight(component),
        role: 'support',
      })
    }
  }

  return layouts
}

function createComponentShape(
  store: TLStore,
  diagramId: string,
  component: ArchitectureComponent,
  layout: ComponentLayout,
  shapeId: TLShapeId,
  index: number
) {
  return store.schema.types.shape.create({
    id: shapeId,
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
      color: 'blue',
      fill: layout.role === 'primary' ? 'semi' : 'none',
      size: 'm',
      font: 'sans',
      align: 'start',
      verticalAlign: 'start',
      richText: toRichText(componentBody(component)),
    },
    meta: architectureMeta(diagramId, 'component', {
      elementId: component.id,
      actions: component.actions,
      errors: component.errors,
      evidence: component.evidence,
    }),
  }) as TLShape
}

function createConnectionRecords(
  store: TLStore,
  diagramId: string,
  connection: ArchitectureConnection,
  connectionIndex: number,
  from: ComponentLayout,
  to: ComponentLayout,
  anchors: { start: Anchor; end: Anchor },
  fromShapeId: TLShapeId,
  toShapeId: TLShapeId,
  index: number
) {
  const sameRow = Math.abs(centerY(to) - centerY(from)) < 1
  const startAnchor = anchors.start
  const endAnchor = anchors.end
  const start = pointAtAnchor(from, startAnchor)
  const end = pointAtAnchor(to, endAnchor)
  const arrowId = createShapeId(`${diagramId}-connection-${connectionIndex}`)
  const meta = architectureMeta(diagramId, 'connection', {
    elementId: `${connection.from}->${connection.to}:${connectionIndex}`,
    from: connection.from,
    to: connection.to,
    call: connection.call,
    evidence: connection.evidence,
  })

  const arrow = store.schema.types.shape.create({
    id: arrowId,
    type: 'arrow',
    parentId: PAGE_ID,
    index: indexKey(index),
    x: start.x,
    y: start.y,
    props: {
      kind: 'elbow',
      labelColor: 'black',
      color: 'black',
      fill: 'none',
      dash: 'solid',
      size: 's',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      font: 'sans',
      start: { x: 0, y: 0 },
      end: { x: end.x - start.x, y: end.y - start.y },
      bend: 0,
      richText: toRichText(connectionBody(connection)),
      labelPosition: sameRow ? 0.5 : 0.7,
      scale: 1,
      elbowMidPoint: 0.5,
    },
    meta,
  }) as TLShape

  const startBinding = store.schema.types.binding.create({
    id: createBindingId(`${diagramId}-connection-${connectionIndex}-start`),
    type: 'arrow',
    fromId: arrowId,
    toId: fromShapeId,
    props: {
      terminal: 'start',
      normalizedAnchor: startAnchor,
      isExact: false,
      isPrecise: true,
      snap: 'edge',
    },
    meta,
  }) as TLBinding
  const endBinding = store.schema.types.binding.create({
    id: createBindingId(`${diagramId}-connection-${connectionIndex}-end`),
    type: 'arrow',
    fromId: arrowId,
    toId: toShapeId,
    props: {
      terminal: 'end',
      normalizedAnchor: endAnchor,
      isExact: false,
      isPrecise: true,
      snap: 'edge',
    },
    meta,
  }) as TLBinding

  return [arrow, startBinding, endBinding]
}

function connectionAnchors(
  connection: ArchitectureConnection,
  from: ComponentLayout,
  to: ComponentLayout,
  connections: ArchitectureConnection[],
  layouts: Map<string, ComponentLayout>
) {
  const sameRow = Math.abs(centerY(to) - centerY(from)) < 1
  if (sameRow) {
    const goesRight = centerX(to) >= centerX(from)
    return {
      start: { x: goesRight ? 1 : 0, y: 0.5 },
      end: { x: goesRight ? 0 : 1, y: 0.5 },
    }
  }

  const goesDown = centerY(to) >= centerY(from)
  if (from.role === 'primary' && to.role === 'support') {
    const siblings = connections.filter(
      (candidate) => candidate.from === connection.from && layouts.get(candidate.to)?.role === 'support'
    )
    const slot = (siblings.findIndex((candidate) => candidate === connection) + 1) / (siblings.length + 1)
    return { start: { x: slot, y: 1 }, end: { x: 0.5, y: 0 } }
  }
  if (from.role === 'support' && to.role === 'primary') {
    const siblings = connections.filter(
      (candidate) => candidate.to === connection.to && layouts.get(candidate.from)?.role === 'support'
    )
    const slot = (siblings.findIndex((candidate) => candidate === connection) + 1) / (siblings.length + 1)
    return { start: { x: 0.5, y: 0 }, end: { x: slot, y: 1 } }
  }
  return {
    start: { x: 0.5, y: goesDown ? 1 : 0 },
    end: { x: 0.5, y: goesDown ? 0 : 1 },
  }
}

function measureComponentHeight(component: ArchitectureComponent) {
  const lineCount = componentBody(component)
    .split('\n')
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 38)), 0)
  return Math.max(COMPONENT_MIN_H, lineCount * TEXT_LINE_H + TEXT_PADDING_Y)
}

function componentBody(component: ArchitectureComponent) {
  const errors = component.errors.length > 0 ? ['', `Errors: ${component.errors.map((error) => truncateText(error, 28)).join(' · ')}`] : []
  return [component.label, '', ...component.actions.map((action) => `• ${truncateText(action, 52)}`), ...errors].join('\n')
}

function connectionBody(connection: ArchitectureConnection) {
  return truncateText(connection.call, 32)
}

function truncateText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function architectureMeta(diagramId: string, kind: string, extra: Record<string, unknown> = {}) {
  const definedExtra = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined))
  return {
    tldrawMcp: {
      diagramId,
      diagramType: 'architecture',
      metadataVersion: ARCHITECTURE_METADATA_VERSION,
      kind,
      ...definedExtra,
    },
  }
}

function diagramWidth(layouts: Map<string, ComponentLayout>, offsetX: number) {
  return Math.max(COMPONENT_W, ...[...layouts.values()].map((layout) => layout.x + layout.w - offsetX))
}

function pointAtAnchor(layout: ComponentLayout, anchor: { x: number; y: number }) {
  return {
    x: layout.x + layout.w * anchor.x,
    y: layout.y + layout.h * anchor.y,
  }
}

function centerX(layout: ComponentLayout) {
  return layout.x + layout.w / 2
}

function centerY(layout: ComponentLayout) {
  return layout.y + layout.h / 2
}

function findSupportOwner(id: string, connections: ArchitectureConnection[], primaryIds: Set<string>) {
  for (const connection of connections) {
    if (connection.from === id && primaryIds.has(connection.to)) return connection.to
    if (connection.to === id && primaryIds.has(connection.from)) return connection.from
  }
  return undefined
}

function requiredComponent(components: Map<string, ArchitectureComponent>, id: string) {
  const component = components.get(id)
  if (!component) throw new Error(`Architecture component is missing for ${id}.`)
  return component
}

function requiredLayout(layouts: Map<string, ComponentLayout>, id: string) {
  const layout = layouts.get(id)
  if (!layout) throw new Error(`Architecture component layout is missing for ${id}.`)
  return layout
}

function requiredShapeId(ids: Map<string, TLShapeId>, id: string) {
  const shapeId = ids.get(id)
  if (!shapeId) throw new Error(`Architecture component shape is missing for ${id}.`)
  return shapeId
}

function getShapeBounds(store: TLStore): Bounds | null {
  const shapes = store.allRecords().filter((record): record is TLShape => record.typeName === 'shape')
  if (shapes.length === 0) return null
  return shapes.reduce<Bounds>(
    (bounds, shape) => {
      const width = 'w' in shape.props && typeof shape.props.w === 'number' ? shape.props.w : 1
      const height = 'h' in shape.props && typeof shape.props.h === 'number' ? shape.props.h : 1
      const end = shape.type === 'arrow' && 'end' in shape.props ? shape.props.end : { x: width, y: height }
      return {
        minX: Math.min(bounds.minX, shape.x, shape.x + end.x),
        minY: Math.min(bounds.minY, shape.y, shape.y + end.y),
        maxX: Math.max(bounds.maxX, shape.x + width, shape.x + end.x),
        maxY: Math.max(bounds.maxY, shape.y + height, shape.y + end.y),
      }
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  )
}

function indexKey(index: number) {
  let key = null
  for (let current = 0; current < index; current += 1) key = getIndexAbove(key)
  return key
}
