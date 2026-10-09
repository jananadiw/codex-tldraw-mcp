import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (['dist/index.js', 'dist/app.html'].every((file) => existsSync(file))) {
  process.exit(0)
}

const build = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', 'build'] : ['run', 'build'], {
  stdio: 'inherit',
  env: process.env,
})
if (build.error) console.error(build.error.message)
process.exit(build.status ?? 1)
