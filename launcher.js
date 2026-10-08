#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distIndex = join(__dirname, 'dist', 'index.js')

if (existsSync(distIndex)) {
  const { default: main } = await import(distIndex)
  if (typeof main === 'function') {
    await main()
  }
} else {
  const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))
  const packageSpec = `${packageJson.name}@${packageJson.version}`
  
  process.stderr.write(`dist/ not found, falling back to published package: ${packageSpec}\n`)
  
  const npx = spawn('npx', ['-y', packageSpec], {
    cwd: homedir(),
    stdio: 'inherit',
    env: process.env,
  })
  
  process.on('SIGTERM', () => npx.kill('SIGTERM'))
  process.on('SIGINT', () => npx.kill('SIGINT'))
  
  npx.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 1)
    }
  })
  
  npx.on('error', (err) => {
    process.stderr.write(`Failed to run ${packageSpec}: ${err.message}\n`)
    process.exit(1)
  })
}
