import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { boardResourceUri } from '../src/boardResource.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = process.cwd()
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-tldraw-plugin-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args: string[], cwd: string) {
  const result = spawnSync(npm, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

try {
  // Install the real tarball without lifecycle hooks or checkout dependencies.
  const packed = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root))
  const tarball = Array.isArray(packed) ? packed[0] : Object.values(packed)[0] as { filename: string }
  const installRoot = path.join(temporary, 'installed')
  await fs.mkdir(installRoot)
  run(['install', '--prefix', installRoot, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(temporary, tarball.filename)], temporary)
  const pluginRoot = path.join(installRoot, 'node_modules/codex-tldraw-mcp')
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies.tldraw, /^\d+\.\d+\.\d+$/, 'Pin tldraw exactly: generated shape props must match the bundled editor schema')
  const marketplace = JSON.parse(await fs.readFile(path.join(pluginRoot, '.agents/plugins/marketplace.json'), 'utf8'))
  assert.equal(marketplace.plugins[0].source.path, './')
  const config = JSON.parse(await fs.readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'))
  const serverConfig = config.mcpServers['codex-tldraw-app']

  const repoPath = path.join(temporary, 'user repo')
  await fs.mkdir(repoPath)
  await fs.writeFile(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'fixture-app' }))
  await fs.writeFile(path.join(repoPath, 'main.ts'), "import { helper } from './helper.js'; helper()\n")
  await fs.writeFile(path.join(repoPath, 'helper.ts'), 'export function helper() {}\n')
  const client = new Client({ name: 'plugin-install-smoke', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    cwd: path.resolve(pluginRoot, serverConfig.cwd),
    stderr: 'pipe',
  }))
  try {
    const resources = await client.listResources()
    assert.ok(resources.resources.some((resource) => resource.uri === 'ui://codex-tldraw/board.html'))
    for (const invalidPath of [undefined, '.', pluginRoot, path.join(repoPath, 'main.ts')]) {
      const result = await client.callTool({ name: 'diagram_repo', arguments: invalidPath ? { repoPath: invalidPath } : {} })
      assert.equal(result.isError, true, `Expected rejection for repoPath=${invalidPath}`)
    }
    for (const name of ['diagram_repo', 'diagram_code_graph']) {
      const result = await client.callTool({ name, arguments: { repoPath, boardName: 'main' } })
      assert.ok(!result.isError, JSON.stringify(result.content))
      const output = result.structuredContent as Record<string, unknown> | undefined
      assert.equal(output?.repoPath, await fs.realpath(repoPath))
      for (const key of ['boardPath', 'svgPath']) {
        const outputPath: unknown = output?.[key]
        assert.equal(typeof outputPath, 'string')
        assert.equal(path.dirname(outputPath as string), path.join(await fs.realpath(repoPath), 'boards'))
        await fs.access(outputPath as string)
      }
    }
    const resource = await client.readResource({ uri: boardResourceUri(await fs.realpath(repoPath), 'main') })
    const contents = resource.contents[0]
    assert.ok('text' in contents)
    const saved = await client.callTool({ name: 'save_board', arguments: { repoPath, boardName: 'main', tldrJson: contents.text } })
    assert.ok(!saved.isError, JSON.stringify(saved.content))
    const app = await client.readResource({ uri: 'ui://codex-tldraw/board.html' })
    assert.ok(app.contents.some((entry) => 'text' in entry && entry.text.includes('<html')))
    const drift = await client.callTool({ name: 'compare_code_graph', arguments: { repoPath } })
    assert.ok(!drift.isError, JSON.stringify(drift.content))
    assert.equal((await fs.readdir(pluginRoot)).includes('boards'), false)
  } finally {
    await client.close()
  }

  const standalone = new Client({ name: 'standalone-default-smoke', version: '1.0.0' })
  await standalone.connect(new StdioClientTransport({
    command: 'node',
    args: [path.join(pluginRoot, 'dist/index.js')],
    cwd: repoPath,
    stderr: 'pipe',
  }))
  try {
    const result = await standalone.callTool({ name: 'list_boards', arguments: {} })
    assert.ok(!result.isError, JSON.stringify(result.content))
    assert.equal((result.structuredContent as Record<string, unknown>).repoPath, await fs.realpath(repoPath))
  } finally {
    await standalone.close()
  }

  // A GitHub download has source but no dist or dependencies. Check npx fallback
  // without depending on a release being published or changing a user's install.
  if (process.platform !== 'win32') {
    const fallbackRoot = path.join(temporary, 'source-only')
    const bin = path.join(temporary, 'bin')
    await fs.mkdir(fallbackRoot)
    await fs.mkdir(bin)
    await fs.copyFile(path.join(root, 'launcher.js'), path.join(fallbackRoot, 'launcher.js'))
    await fs.copyFile(path.join(root, 'package.json'), path.join(fallbackRoot, 'package.json'))
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    const fakeNpx = path.join(bin, 'npx')
    await fs.writeFile(fakeNpx, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), root: process.env.TLDRAW_MCP_PLUGIN_ROOT, cwd: process.cwd() })); process.exit(7)\n`, { mode: 0o755 })
    const fallback = spawnSync('node', [path.join(fallbackRoot, 'launcher.js')], {
      cwd: fallbackRoot,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    })
    assert.equal(fallback.status, 7, fallback.stderr)
    const launched = JSON.parse(fallback.stdout)
    assert.deepEqual(launched.args, ['-y', '--package', `${manifest.name}@${manifest.version}`, 'codex-tldraw-mcp'])
    assert.equal(launched.root, await fs.realpath(fallbackRoot))
    assert.notEqual(launched.cwd, fallbackRoot)
  }
  console.log('Plugin tarball install, launch, repo routing, artifacts, editor resource, save, drift, and source-only fallback passed.')
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
