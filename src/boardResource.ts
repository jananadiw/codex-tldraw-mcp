export type BoardResourceKind = 'file' | 'svg' | 'summary'

export function boardResourceUri(repoPath: string, boardName: string, kind: BoardResourceKind = 'file') {
  return `tldraw://repos/${encodeURIComponent(repoPath)}/boards/${encodeURIComponent(boardName)}/${kind}`
}

export function parseBoardResourceUri(uri: string) {
  const match = /^tldraw:\/\/repos\/([^/]+)\/boards\/([^/]+)\/(file|svg|summary)$/.exec(uri)
  if (!match) return null
  return {
    repoPath: decodeURIComponent(match[1]),
    boardName: decodeURIComponent(match[2]),
    kind: match[3] as BoardResourceKind,
  }
}
