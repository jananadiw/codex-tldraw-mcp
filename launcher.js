#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distIndex = join(__dirname, 'dist', 'index.js')

if (existsSync(distIndex)) {
  const { default: main } = await import(distIndex)
  if (typeof main === 'function') {
    await main()
  }
} else {
  console.error('Error: dist/index.js not found. Building now...')
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  })
  
  if (build.status !== 0) {
    console.error('\nBuild failed. If you installed from Git, please run:')
    console.error('  cd', __dirname)
    console.error('  npm install')
    console.error('  npm run build')
    process.exit(1)
  }
  
  const { default: main } = await import(distIndex)
  if (typeof main === 'function') {
    await main()
  }
}
