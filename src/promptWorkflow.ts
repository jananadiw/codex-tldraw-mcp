import type { ProductWorkflow, WorkflowConnection, WorkflowStep } from './types.js'

const STEP_ID_PATTERN = /^[a-zA-Z0-9._-]+$/

export interface PromptWorkflowStep {
  id?: string
  label: string
  detail?: string
}

export interface PromptWorkflowConnection {
  from: string
  to: string
  label?: string
}

export function buildPromptWorkflow(
  title: string,
  repoPath: string,
  steps: PromptWorkflowStep[],
  connections?: PromptWorkflowConnection[]
): ProductWorkflow {
  const repoName = title.trim()
  if (!repoName) throw new Error('Diagram title cannot be empty.')
  const workflowSteps = normalizePromptSteps(steps)
  const workflowConnections = connections
    ? normalizePromptConnections(connections, workflowSteps)
    : buildSequentialConnections(workflowSteps)

  return {
    repoName,
    repoPath,
    steps: workflowSteps,
    connections: workflowConnections,
  }
}

function normalizePromptSteps(steps: PromptWorkflowStep[]): WorkflowStep[] {
  const ids = new Set<string>()
  return steps.map((input, index) => {
    const label = input.label.trim()
    if (!label) throw new Error(`Step ${index + 1} label cannot be empty.`)
    const id = input.id?.trim() || uniqueStepId(label, index, ids)
    if (!STEP_ID_PATTERN.test(id)) {
      throw new Error(`Step id must contain only letters, numbers, dots, underscores, or dashes: ${id}`)
    }
    if (ids.has(id)) throw new Error(`Duplicate step id: ${id}`)
    ids.add(id)
    return {
      id,
      label,
      detail: input.detail?.trim() || undefined,
      evidence: [],
    }
  })
}

function uniqueStepId(label: string, index: number, existingIds: Set<string>) {
  const base = slugify(label) || `step-${index + 1}`
  let candidate = base
  let suffix = 2
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function normalizePromptConnections(connections: PromptWorkflowConnection[], steps: WorkflowStep[]): WorkflowConnection[] {
  const stepIds = new Set(steps.map((step) => step.id))
  return connections.map((connection) => {
    if (!stepIds.has(connection.from)) throw new Error(`Connection references unknown from step: ${connection.from}`)
    if (!stepIds.has(connection.to)) throw new Error(`Connection references unknown to step: ${connection.to}`)
    return {
      from: connection.from,
      to: connection.to,
      label: connection.label?.trim() || '',
    }
  })
}

function buildSequentialConnections(steps: WorkflowStep[]) {
  const connections: WorkflowConnection[] = []
  for (let index = 0; index < steps.length - 1; index += 1) {
    connections.push({
      from: steps[index].id,
      to: steps[index + 1].id,
      label: '',
    })
  }
  return connections
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
