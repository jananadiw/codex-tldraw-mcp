import type { ArchitectureComponent, ArchitectureConnection, ArchitectureDiagram } from './types.js'

const ID_PATTERN = /^[a-zA-Z0-9._-]+$/

export const ARCHITECTURE_ANALYSIS_INSTRUCTIONS = `
When drawing repository architecture, keep the result simple and useful to someone learning the codebase:
1. Identify 2-7 main runtime components. Keep libraries and helper modules as actions, not separate components.
2. Put the 2-4 components in the user's main path in primaryFlow, from the first action to the final result.
3. Give each component at most 3 short actions and at most 2 short caller-visible errors.
4. Use one connection per interaction. Combine the request and response in one short label instead of drawing a return arrow.
5. Keep connection labels under 32 characters. Do not put error text on arrows.
6. Add repository-relative source evidence when available, but keep evidence out of the visible diagram.
The reader should understand the main path first, then see supporting services below it.
`.trim()

interface ArchitectureComponentInput {
  id: string
  label: string
  actions: string[]
  errors?: string[]
  evidence?: string[]
}

interface ArchitectureConnectionInput {
  from: string
  to: string
  call: string
  evidence?: string[]
}

export function buildArchitectureDiagram(
  title: string,
  repoPath: string,
  components: ArchitectureComponentInput[],
  primaryFlow: string[],
  connections: ArchitectureConnectionInput[]
): ArchitectureDiagram {
  const normalizedTitle = requiredText(title, 'Architecture diagram title')
  if (components.length === 0) throw new Error('Architecture diagram requires at least one component.')

  const normalizedComponents = normalizeComponents(components)
  const componentIds = new Set(normalizedComponents.map((component) => component.id))
  const normalizedPrimaryFlow = normalizePrimaryFlow(primaryFlow, componentIds)
  const normalizedConnections = normalizeConnections(connections, componentIds)
  validatePrimaryConnections(normalizedPrimaryFlow, normalizedConnections)

  return {
    title: normalizedTitle,
    repoPath,
    components: normalizedComponents,
    primaryFlow: normalizedPrimaryFlow,
    connections: normalizedConnections,
  }
}

function normalizeComponents(components: ArchitectureComponentInput[]): ArchitectureComponent[] {
  const ids = new Set<string>()
  return components.map((component, index) => {
    const id = uniqueId(component.id, `Component ${index + 1}`, ids)
    const actions = uniqueTexts(component.actions).slice(0, 3)
    if (actions.length === 0) throw new Error(`Component ${id} requires at least one action.`)
    return {
      id,
      label: requiredText(component.label, `Component ${id} label`),
      actions,
      errors: uniqueTexts(component.errors ?? []).slice(0, 2),
      evidence: uniqueTexts(component.evidence ?? []),
    }
  })
}

function normalizePrimaryFlow(primaryFlow: string[], componentIds: Set<string>) {
  const normalized = uniqueTexts(primaryFlow)
  if (normalized.length < 2) throw new Error('Architecture diagram primaryFlow requires at least two components.')
  for (const id of normalized) {
    if (!componentIds.has(id)) throw new Error(`Primary flow references unknown component: ${id}`)
  }
  return normalized
}

function normalizeConnections(
  connections: ArchitectureConnectionInput[],
  componentIds: Set<string>
): ArchitectureConnection[] {
  const pairs = new Set<string>()
  return connections.map((connection, index) => {
    const from = requiredText(connection.from, `Connection ${index + 1} source`)
    const to = requiredText(connection.to, `Connection ${index + 1} destination`)
    if (!componentIds.has(from)) throw new Error(`Connection references unknown source component: ${from}`)
    if (!componentIds.has(to)) throw new Error(`Connection references unknown destination component: ${to}`)
    if (from === to) throw new Error(`Connection cannot link component ${from} to itself.`)
    const pair = [from, to].sort().join('::')
    if (pairs.has(pair)) {
      throw new Error(`Components ${from} and ${to} must use one combined request/response connection.`)
    }
    pairs.add(pair)
    return {
      from,
      to,
      call: requiredText(connection.call, `Connection ${from} -> ${to} call`),
      evidence: uniqueTexts(connection.evidence ?? []),
    }
  })
}

function validatePrimaryConnections(primaryFlow: string[], connections: ArchitectureConnection[]) {
  for (let index = 0; index < primaryFlow.length - 1; index += 1) {
    const from = primaryFlow[index]
    const to = primaryFlow[index + 1]
    if (!connections.some((connection) => connection.from === from && connection.to === to)) {
      throw new Error(`Primary flow requires a connection from ${from} to ${to}.`)
    }
  }
}

function uniqueId(value: string, field: string, ids: Set<string>) {
  const id = requiredText(value, `${field} id`)
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${field} id must contain only letters, numbers, dots, underscores, or dashes: ${id}`)
  }
  if (ids.has(id)) throw new Error(`Duplicate architecture component id: ${id}`)
  ids.add(id)
  return id
}

function uniqueTexts(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function requiredText(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} cannot be empty.`)
  return normalized
}
