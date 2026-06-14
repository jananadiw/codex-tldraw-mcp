export interface WorkflowStep {
  id: string
  label: string
  detail?: string
  evidence: string[]
}

export interface WorkflowConnection {
  from: string
  to: string
  label: string
}

export interface ProductWorkflow {
  repoName: string
  repoPath: string
  steps: WorkflowStep[]
  connections: WorkflowConnection[]
}

export interface DiagramResult {
  boardName: string
  boardPath: string
  repoPath: string
  diagramId: string
  stepCount: number
  connectionCount: number
  shapeCount: number
  appended: boolean
}

export interface BoardSummary {
  boardName: string
  boardPath: string
  shapeCount: number
  shapesByType: Record<string, number>
  diagrams: Array<{
    diagramId: string
    repoName?: string
    repoPath?: string
    shapeCount: number
    labels: string[]
  }>
}
