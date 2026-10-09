#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = dirname(fileURLToPath(import.meta.url))
process.env.TLDRAW_MCP_PLUGIN_ROOT = pluginRoot
const entry = join(pluginRoot, 'dist/index.js')
const require = createRequire(import.meta.url)
let localBuildReady = existsSync(entry) && existsSync(join(pluginRoot, 'dist/app.html'))
try {
  require.resolve('@modelcontextprotocol/sdk/server/stdio.js')
  require.resolve('@modelcontextprotocol/ext-apps/server')
  require.resolve('typescript')
  require.resolve('zod')
  require.resolve('tldraw')
  require.resolve('proper-lockfile')
} catch {
  localBuildReady = false
}

if (localBuildReady) {
  await import(pathToFileURL(entry).href)
} else {
  const { name, version } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  const packageSpec = `${name}@${version}`
  process.stderr.write(`Using published ${packageSpec}; the plugin has no runnable local build.\n`)
  const args = ['-y', '--package', packageSpec, 'codex-tldraw-mcp']
  const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...args] : args, {
    cwd: tmpdir(),
    stdio: 'inherit',
    env: process.env,
  })
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  process.on('SIGINT', () => child.kill('SIGINT'))
  child.on('error', (error) => {
    process.stderr.write(`Cannot start ${packageSpec}: ${error.message}. Install Node.js and npm, then retry.\n`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}
