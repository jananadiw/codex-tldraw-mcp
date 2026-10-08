import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const required = ['dist/index.js', 'dist/app.html']
if (required.every((file) => fs.existsSync(file))) {
  process.exit(0)
}

const build = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  env: process.env,
})

process.exit(build.status ?? 1)
