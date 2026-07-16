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
    diagramType?: string
    repoName?: string
    repoPath?: string
    shapeCount: number
    labels: string[]
    driftStatusCounts?: Partial<Record<CodeGraphDriftStatus, number>>
  }>
}

export type CodeGraphImportKind = 'dynamic-import' | 'import' | 're-export' | 'require'

export interface CodeGraphNode {
  id: string
  label: string
  sourcePath: string
  fingerprint: string
  localImportCount: number
}

export interface CodeGraphEdge {
  id: string
  from: string
  to: string
  kind: CodeGraphImportKind
  fingerprint: string
}

export interface CodeGraph {
  repoName: string
  repoPath: string
  nodes: CodeGraphNode[]
  edges: CodeGraphEdge[]
  externalImportCount: number
  unresolvedImports: Array<{
    from: string
    specifier: string
  }>
}

export type CodeGraphElementKind = 'edge' | 'node'
export type CodeGraphDriftStatus = 'changed' | 'new' | 'stale' | 'unchanged'

export interface CodeGraphElement {
  id: string
  kind: CodeGraphElementKind
  fingerprint: string
}

export interface StoredCodeGraph {
  diagramId: string
  elements: CodeGraphElement[]
}

export interface CodeGraphDriftElement extends CodeGraphElement {
  status: CodeGraphDriftStatus
}

export interface CodeGraphDriftResult {
  diagramId: string
  elements: CodeGraphDriftElement[]
  counts: Record<CodeGraphDriftStatus, number>
}
