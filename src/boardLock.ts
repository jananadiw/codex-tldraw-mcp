import fs from 'node:fs/promises'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { assertBoardLocation } from './tldrawBoard.js'

const pending = new Map<string, Promise<unknown>>()

// Serialize read-modify-write operations within and across server processes.
export async function withBoardLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await assertBoardLocation(key, path.dirname(path.dirname(key)))
    await fs.mkdir(path.dirname(key), { recursive: true })
    const release = await lockfile.lock(key, {
      realpath: false,
      retries: { retries: 25, minTimeout: 50, maxTimeout: 500 },
    })
    try {
      return await run()
    } finally {
      await release()
    }
  })
  pending.set(key, next)
  try {
    return await next
  } finally {
    if (pending.get(key) === next) pending.delete(key)
  }
}
