import path from 'node:path'

const BOARD_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

export function workspaceRoot() {
  return process.cwd()
}

export function boardsDir(root = workspaceRoot()) {
  return path.join(root, 'boards')
}

export function normalizeBoardName(name = 'main') {
  const trimmed = name.trim()
  const withoutExtension = trimmed.endsWith('.tldr') ? trimmed.slice(0, -5) : trimmed
  if (!withoutExtension || !BOARD_NAME_PATTERN.test(withoutExtension)) {
    throw new Error('Board name must contain only letters, numbers, dots, underscores, or dashes.')
  }
  return withoutExtension
}

export function boardPath(name = 'main', root = workspaceRoot()) {
  return path.join(boardsDir(root), `${normalizeBoardName(name)}.tldr`)
}
