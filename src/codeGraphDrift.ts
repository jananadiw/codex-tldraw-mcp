import type {
  CodeGraph,
  CodeGraphDriftElement,
  CodeGraphDriftResult,
  CodeGraphElement,
  StoredCodeGraph,
} from './types.js'

export function compareCodeGraphs(stored: StoredCodeGraph, current: CodeGraph): CodeGraphDriftResult {
  const storedElements = new Map(stored.elements.map((element) => [elementKey(element), element]))
  const currentElements = new Map(codeGraphElements(current).map((element) => [elementKey(element), element]))
  const elements: CodeGraphDriftElement[] = []

  for (const previous of stored.elements) {
    const currentElement = currentElements.get(elementKey(previous))
    elements.push({
      ...(currentElement ?? previous),
      status: currentElement ? (currentElement.fingerprint === previous.fingerprint ? 'unchanged' : 'changed') : 'stale',
    })
  }

  for (const currentElement of currentElements.values()) {
    if (!storedElements.has(elementKey(currentElement))) {
      elements.push({ ...currentElement, status: 'new' })
    }
  }

  elements.sort((a, b) => `${a.status}:${a.kind}:${a.id}`.localeCompare(`${b.status}:${b.kind}:${b.id}`))
  return {
    diagramId: stored.diagramId,
    elements,
    counts: {
      changed: elements.filter((element) => element.status === 'changed').length,
      new: elements.filter((element) => element.status === 'new').length,
      stale: elements.filter((element) => element.status === 'stale').length,
      unchanged: elements.filter((element) => element.status === 'unchanged').length,
    },
  }
}

function codeGraphElements(graph: CodeGraph): CodeGraphElement[] {
  return [
    ...graph.nodes.map((node) => ({ id: node.id, kind: 'node' as const, fingerprint: node.fingerprint })),
    ...graph.edges.map((edge) => ({ id: edge.id, kind: 'edge' as const, fingerprint: edge.fingerprint })),
  ]
}

function elementKey(element: Pick<CodeGraphElement, 'id' | 'kind'>) {
  return `${element.kind}:${element.id}`
}
