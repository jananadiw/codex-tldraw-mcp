import type { WorkflowConnection, WorkflowStep } from './types.js'

export function buildSequentialConnections(steps: WorkflowStep[]) {
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
