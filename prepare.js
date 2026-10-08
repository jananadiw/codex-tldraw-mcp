#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const required = ['dist/index.js', 'dist/app.html']
if (required.every((file) => existsSync(file))) {
  process.exit(0)
}

if (!existsSync('scripts') || !existsSync('src')) {
  console.log('Skipping build: source files not available (packaged installation)')
  process.exit(0)
}

const build = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  env: process.env,
})

process.exit(build.status ?? 1)
