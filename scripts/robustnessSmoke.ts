import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { boardResourceUri } from '../src/boardResource.js'
import { scanCodeGraph } from '../src/codeGraphScanner.js'
import { scanRepo } from '../src/repoScanner.js'
import { boardEtag } from '../src/tldrawBoard.js'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tldraw-robustness-'))
const clients: Client[] = []
async function connect(allowedRoot?: string) {
  const client = new Client({ name: 'robustness-smoke', version: '1' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [path.resolve('dist/index.js')], stderr: 'pipe', env: allowedRoot ? { TLDRAW_MCP_ALLOWED_ROOTS: allowedRoot } : undefined }))
  clients.push(client)
  return client
}
async function read(client: Client, uri: string) {
  const result = await client.readResource({ uri })
  const content = result.contents[0]
  assert.ok('text' in content)
  return { text: content.text, etag: content._meta?.etag }
}
try {
  const first = path.join(temporary, 'repo ü 100%')
  const second = path.join(temporary, 'second')
  await Promise.all([fs.mkdir(first), fs.mkdir(second)])
  const a = await connect()
  const b = await connect() // Simulates a restarted server with no last-repo state.
  for (const [repoPath, title] of [[first, 'First repo'], [second, 'Second repo']]) {
    const result = await a.callTool({ name: 'draw_canvas', arguments: { repoPath, title, steps: [{ label: title }] } })
    assert.ok(!result.isError, JSON.stringify(result.content))
    const expectedUri = boardResourceUri(await fs.realpath(repoPath), 'main')
    const content = result.content as Array<{ type: string; uri?: string }>
    assert.ok(content.some((entry) => entry.type === 'resource_link' && entry.uri === expectedUri))
  }
  const uri = boardResourceUri(await fs.realpath(first), 'main')
  const original = await read(b, uri)
  assert.ok(original.text.includes('First repo'))
  assert.ok(!original.text.includes('Second repo'))
  assert.equal(original.etag, boardEtag(original.text))
  await read(b, boardResourceUri(await fs.realpath(second), 'main'))
  assert.equal((await read(b, uri)).text, original.text)
  await read(b, boardResourceUri(await fs.realpath(first), 'main', 'svg'))
  await read(b, boardResourceUri(await fs.realpath(first), 'main', 'summary'))
  const restricted = await connect(first)
  await read(restricted, uri)
  await assert.rejects(() => read(restricted, boardResourceUri(second, 'main')), /outside TLDRAW_MCP_ALLOWED_ROOTS/)
  if (process.platform !== 'win32') await read(await connect('/'), uri)

  for (const tldrJson of ['{', '{}', '{"tldrawFileFormatVersion":1,"schema":{},"records":[{}]}']) {
    const rejected = await b.callTool({ name: 'save_board', arguments: { repoPath: first, boardName: 'main', tldrJson } })
    assert.equal(rejected.isError, true)
    assert.equal((await read(b, uri)).text, original.text, 'Invalid save must preserve the original board')
  }
  const preview = await fs.readFile(path.join(first, 'boards/main.svg'), 'utf8')
  const writes = await Promise.all([a, b].map((client, index) => client.callTool({
    name: 'draw_canvas', arguments: { repoPath: first, title: `Concurrent ${index}`, steps: [{ label: `Concurrent ${index}` }] },
  })))
  for (const result of writes) assert.ok(!result.isError, JSON.stringify(result.content))
  const combined = await read(b, uri)
  assert.ok(combined.text.includes('Concurrent 0') && combined.text.includes('Concurrent 1'), 'Concurrent appends must both survive')
  assert.notEqual(await fs.readFile(path.join(first, 'boards/main.svg'), 'utf8'), preview)
  const stale = await b.callTool({ name: 'save_board', arguments: { repoPath: first, boardName: 'main', tldrJson: original.text, ifMatch: original.etag } })
  assert.equal(stale.isError, true)
  assert.equal((await read(b, uri)).text, combined.text)
  const saves = await Promise.all([a, b].map((client) => client.callTool({ name: 'save_board', arguments: {
    repoPath: first, boardName: 'main', tldrJson: combined.text.replaceAll('First repo', `Edited ${client === a ? 0 : 1}`), ifMatch: combined.etag,
  } })))
  assert.equal(saves.filter((result) => !result.isError).length, 1, 'Only one competing editor save may win')

  await fs.mkdir(path.join(second, 'assets'))
  for (let offset = 0; offset < 5100; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(second, `assets/${offset + i}.jpg`), 'x')))
  }
  await fs.writeFile(path.join(second, 'main.ts'), 'export const main = 1')
  await fs.writeFile(path.join(second, 'package.json'), '{"name":123}')
  assert.equal((await scanCodeGraph(second)).nodes.length, 1)
  await fs.writeFile(path.join(second, 'upload.ts'), '// upload file; main task\n')
  const workflow = await scanRepo(second)
  assert.equal(workflow.repoName, 'second')
  assert.ok(workflow.steps.some((step) => step.label === 'App processes the input'), 'main must not falsely match AI')

  if (process.platform !== 'win32') {
    const linked = path.join(temporary, 'linked')
    await fs.mkdir(linked)
    await fs.symlink(path.join(first, 'boards'), path.join(linked, 'boards'), 'dir')
    const escaped = await a.callTool({ name: 'draw_canvas', arguments: { repoPath: linked, title: 'Escape', steps: [{ label: 'Escape' }] } })
    assert.equal(escaped.isError, true)
    const listing = await a.callTool({ name: 'list_boards', arguments: { repoPath: linked } })
    assert.equal(listing.isError, true)
    assert.ok(!(await read(b, uri)).text.includes('Escape'))
  }
  console.log('Restarted resource reads, same-named boards, invalid saves, conflicts, concurrent appends, asset-heavy scans, and symlink confinement passed.')
} finally {
  await Promise.all(clients.map((client) => client.close()))
  await fs.rm(temporary, { recursive: true, force: true })
}

process.exit(0)
