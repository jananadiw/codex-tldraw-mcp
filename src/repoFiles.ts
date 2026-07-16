import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_FILES = 500
const IGNORE_DIRS = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'out',
  'target',
  '.turbo',
])

export async function walkRepo(root: string, maxFiles = DEFAULT_MAX_FILES) {
  return (await scanRepoFiles(root, maxFiles)).files
}

export async function scanRepoFiles(root: string, maxFiles = DEFAULT_MAX_FILES) {
  const results: string[] = []

  async function visit(dir: string) {
    if (results.length > maxFiles) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (results.length > maxFiles) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(root, fullPath)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await visit(fullPath)
      } else if (entry.isFile()) {
        results.push(relativePath)
      }
    }
  }

  await visit(root)
  return {
    files: results.slice(0, maxFiles),
    truncated: results.length > maxFiles,
  }
}
