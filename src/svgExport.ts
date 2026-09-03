import type { TLShape, TLStore } from 'tldraw'

type Point = { x: number; y: number }
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

const PADDING = 48
const COLORS: Record<string, { stroke: string; fill: string }> = {
  black: { stroke: '#212529', fill: '#f8f9fa' },
  blue: { stroke: '#4263eb', fill: '#dbe4ff' },
  'light-blue': { stroke: '#1c7ed6', fill: '#d0ebff' },
  violet: { stroke: '#7048e8', fill: '#e5dbff' },
  green: { stroke: '#2b8a3e', fill: '#d3f9d8' },
  orange: { stroke: '#e8590c', fill: '#ffe8cc' },
  red: { stroke: '#c92a2a', fill: '#ffe3e3' },
  yellow: { stroke: '#e67700', fill: '#fff3bf' },
  grey: { stroke: '#495057', fill: '#f1f3f5' },
}

export function renderBoardSvg(store: TLStore) {
  const shapes = store
    .allRecords()
    .filter((record): record is TLShape => record.typeName === 'shape')
    .filter((shape) => shape.type === 'arrow' || shape.type === 'geo' || shape.type === 'text')
    .sort((a, b) => String(a.index).localeCompare(String(b.index)))
  const bounds = boardBounds(shapes)
  const width = Math.max(1, bounds.maxX - bounds.minX + PADDING * 2)
  const height = Math.max(1, bounds.maxY - bounds.minY + PADDING * 2)
  const offsetX = PADDING - bounds.minX
  const offsetY = PADDING - bounds.minY
  const body = shapes.map((shape) => renderShape(shape, offsetX, offsetY)).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" role="img" aria-label="tldraw board preview">`,
    '  <rect width="100%" height="100%" fill="#ffffff"/>',
    '  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif">',
    indent(body, 4),
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}

function renderShape(shape: TLShape, offsetX: number, offsetY: number) {
  const content =
    shape.type === 'geo'
      ? renderGeo(shape, offsetX, offsetY)
      : shape.type === 'arrow'
        ? renderArrow(shape, offsetX, offsetY)
        : renderText(shape, offsetX, offsetY)
  return `<g data-shape-id="${xml(shape.id)}">\n${indent(content, 2)}\n</g>`
}

function renderGeo(shape: TLShape, offsetX: number, offsetY: number) {
  const props = shape.props as Record<string, unknown>
  const x = shape.x + offsetX
  const y = shape.y + offsetY
  const w = numberProp(props, 'w', 320)
  const h = numberProp(props, 'h', 120)
  const palette = color(String(props.color ?? 'black'))
  const fill = props.fill === 'none' ? '#ffffff' : palette.fill
  const dash = props.dash === 'dashed' ? ' stroke-dasharray="10 7"' : ''
  const lines = wrapLines(richTextLines(props.richText), Math.max(12, Math.floor((w - 40) / 7.5)))
  const alignStart = props.align === 'start'
  const lineHeight = 24
  const textX = alignStart ? x + 20 : x + w / 2
  const textAnchor = alignStart ? 'start' : 'middle'
  const firstY =
    props.verticalAlign === 'start' ? y + 31 : y + h / 2 - ((lines.length - 1) * lineHeight) / 2 + 7
  const text = renderTextLines(lines, textX, firstY, lineHeight, textAnchor, 16)

  return [
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="10" fill="${fill}" stroke="${palette.stroke}" stroke-width="3"${dash}/>`,
    text,
  ].join('\n')
}

function renderText(shape: TLShape, offsetX: number, offsetY: number) {
  const props = shape.props as Record<string, unknown>
  const x = shape.x + offsetX
  const y = shape.y + offsetY
  const fontSize = textSize(String(props.size ?? 'm'))
  const lineHeight = fontSize * 1.2
  const lines = richTextLines(props.richText)
  const palette = color(String(props.color ?? 'black'))
  return renderTextLines(lines, x, y + fontSize, lineHeight, 'start', fontSize, palette.stroke)
}

function renderArrow(shape: TLShape, offsetX: number, offsetY: number) {
  const props = shape.props as Record<string, unknown>
  const points = arrowPoints(shape, props).map((point) => ({ x: point.x + offsetX, y: point.y + offsetY }))
  const palette = color(String(props.color ?? 'black'))
  const dash = props.dash === 'dashed' ? ' stroke-dasharray="10 7"' : ''
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ')
  const parts = [`<path d="${path}" fill="none" stroke="${palette.stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${dash}/>`]

  if (props.arrowheadEnd !== 'none' && points.length > 1) {
    parts.push(renderArrowhead(points.at(-2)!, points.at(-1)!, palette.stroke))
  }

  const label = richTextLines(props.richText).filter(Boolean).join(' ')
  if (label) {
    const point = pointAlongPath(points, numberProp(props, 'labelPosition', 0.5))
    const labelWidth = Math.max(28, label.length * 7.5 + 14)
    parts.push(
      `<rect x="${round(point.x - labelWidth / 2)}" y="${round(point.y - 13)}" width="${round(labelWidth)}" height="26" rx="5" fill="#ffffff" fill-opacity="0.94"/>`,
      `<text x="${round(point.x)}" y="${round(point.y + 5)}" text-anchor="middle" font-size="14" fill="#212529">${xml(label)}</text>`
    )
  }
  return parts.join('\n')
}

function arrowPoints(shape: TLShape, props: Record<string, unknown>) {
  const start = pointProp(props.start)
  const end = pointProp(props.end)
  const first = { x: shape.x + start.x, y: shape.y + start.y }
  const last = { x: shape.x + end.x, y: shape.y + end.y }
  if (props.kind !== 'elbow' || first.x === last.x || first.y === last.y) return [first, last]

  const midpoint = numberProp(props, 'elbowMidPoint', 0.5)
  if (Math.abs(last.x - first.x) >= Math.abs(last.y - first.y)) {
    const middleX = first.x + (last.x - first.x) * midpoint
    return [first, { x: middleX, y: first.y }, { x: middleX, y: last.y }, last]
  }
  const middleY = first.y + (last.y - first.y) * midpoint
  return [first, { x: first.x, y: middleY }, { x: last.x, y: middleY }, last]
}

function renderArrowhead(from: Point, to: Point, fill: string) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const unitX = dx / length
  const unitY = dy / length
  const baseX = to.x - unitX * 13
  const baseY = to.y - unitY * 13
  const perpendicularX = -unitY * 5.5
  const perpendicularY = unitX * 5.5
  return `<polygon points="${round(to.x)},${round(to.y)} ${round(baseX + perpendicularX)},${round(baseY + perpendicularY)} ${round(baseX - perpendicularX)},${round(baseY - perpendicularY)}" fill="${fill}"/>`
}

function boardBounds(shapes: TLShape[]): Bounds {
  if (shapes.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return shapes.reduce<Bounds>((bounds, shape) => mergeBounds(bounds, shapeBounds(shape)), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  })
}

function shapeBounds(shape: TLShape): Bounds {
  const props = shape.props as Record<string, unknown>
  if (shape.type === 'arrow') {
    const points = arrowPoints(shape, props)
    return points.reduce<Bounds>((bounds, point) => mergeBounds(bounds, {
      minX: point.x,
      minY: point.y,
      maxX: point.x,
      maxY: point.y,
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  }
  if (shape.type === 'text') {
    const fontSize = textSize(String(props.size ?? 'm'))
    const lines = richTextLines(props.richText)
    return {
      minX: shape.x,
      minY: shape.y,
      maxX: shape.x + numberProp(props, 'w', longestLine(lines).length * fontSize * 0.6),
      maxY: shape.y + Math.max(1, lines.length) * fontSize * 1.2,
    }
  }
  return {
    minX: shape.x,
    minY: shape.y,
    maxX: shape.x + numberProp(props, 'w', 320),
    maxY: shape.y + numberProp(props, 'h', 120),
  }
}

function richTextLines(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['']
  const content = (value as { content?: unknown[] }).content
  if (!Array.isArray(content)) return [richTextNode(value)]
  const lines = content.flatMap((node) => richTextNode(node).split('\n'))
  return lines.length > 0 ? lines : ['']
}

function richTextNode(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const node = value as { text?: string; content?: unknown[] }
  if (typeof node.text === 'string') return node.text
  return Array.isArray(node.content) ? node.content.map(richTextNode).join('') : ''
}

function wrapLines(lines: string[], maxLength: number) {
  return lines.flatMap((line) => wrapLine(line, maxLength))
}

function wrapLine(line: string, maxLength: number) {
  if (!line || line.length <= maxLength) return [line]
  const result: string[] = []
  let current = ''
  for (const word of line.split(/\s+/).flatMap((part) => chunk(part, maxLength))) {
    const candidate = current ? `${current} ${word}` : word
    if (current && candidate.length > maxLength) {
      result.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) result.push(current)
  return result
}

function chunk(value: string, maxLength: number) {
  if (value.length <= maxLength) return [value]
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += maxLength) chunks.push(value.slice(index, index + maxLength))
  return chunks
}

function renderTextLines(
  lines: string[],
  x: number,
  firstY: number,
  lineHeight: number,
  anchor: 'start' | 'middle',
  fontSize: number,
  fill = '#212529'
) {
  return `<text x="${round(x)}" y="${round(firstY)}" text-anchor="${anchor}" font-size="${round(fontSize)}" fill="${fill}">${lines
    .map((line, index) => `<tspan x="${round(x)}" dy="${index === 0 ? 0 : round(lineHeight)}"${index === 0 ? ' font-weight="600"' : ''}>${xml(line) || '&#160;'}</tspan>`)
    .join('')}</text>`
}

function pointAlongPath(points: Point[], ratio: number) {
  const segments = points.slice(1).map((point, index) => ({
    from: points[index],
    to: point,
    length: Math.hypot(point.x - points[index].x, point.y - points[index].y),
  }))
  const total = segments.reduce((sum, segment) => sum + segment.length, 0)
  let remaining = total * Math.max(0, Math.min(1, ratio))
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const progress = segment.length === 0 ? 0 : remaining / segment.length
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * progress,
        y: segment.from.y + (segment.to.y - segment.from.y) * progress,
      }
    }
    remaining -= segment.length
  }
  return points.at(-1) ?? { x: 0, y: 0 }
}

function pointProp(value: unknown): Point {
  if (!value || typeof value !== 'object') return { x: 0, y: 0 }
  const point = value as { x?: unknown; y?: unknown }
  return { x: typeof point.x === 'number' ? point.x : 0, y: typeof point.y === 'number' ? point.y : 0 }
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number) {
  return typeof props[key] === 'number' ? props[key] : fallback
}

function color(name: string) {
  return COLORS[name] ?? COLORS.black
}

function textSize(size: string) {
  return { s: 16, m: 20, l: 28, xl: 36 }[size] ?? 20
}

function longestLine(lines: string[]) {
  return lines.reduce((longest, line) => (line.length > longest.length ? line : longest), '')
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function xml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!)
}

function indent(value: string, spaces: number) {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n')
}
