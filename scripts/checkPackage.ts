import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const maximumPackageSize = 800_000
const excludedFiles = new Set([
  'assets/github-project-preview-minimal-under-1mb.jpg',
  'assets/tldrawmcp.gif',
  'assets/codex-tldraw-v0.3.0-demo.mov',
])
const requiredFiles = [
  '.agents/plugins/marketplace.json',
  '.codex-plugin/plugin.json',
  'launcher.js',
  'prepare.js',
  '.mcp.json',
  'CHANGELOG.md',
  'launcher.js',
  'LICENSE',
  'prepare.js',
  'README.md',
  'SECURITY.md',
  'assets/icon-dark.svg',
  'assets/icon.svg',
  'dist/app.html',
  'dist/index.js',
  'package.json',
  'server.json',
]

type PackageManifest = {
  name: string
  version: string
}

type ServerManifest = {
  version: string
  packages: Array<{
    identifier: string
    version: string
  }>
}

type PluginManifest = {
  version: string
}

type PackResult = {
  name: string
  version: string
  size: number
  files: Array<{ path: string }>
}

const packageManifest = readJson<PackageManifest>('package.json')
const serverManifest = readJson<ServerManifest>('server.json')
const pluginManifest = readJson<PluginManifest>('.codex-plugin/plugin.json')
const npmPackage = serverManifest.packages.find((entry) => entry.identifier === packageManifest.name)

if (
  serverManifest.version !== packageManifest.version ||
  npmPackage?.version !== packageManifest.version ||
  pluginManifest.version !== packageManifest.version
) {
  throw new Error(
    `Release versions are inconsistent: package.json=${packageManifest.version}, server.json=${serverManifest.version}, registry package=${npmPackage?.version ?? 'missing'}, plugin=${pluginManifest.version}.`
  )
}

const serverSource = fs.readFileSync('src/server.ts', 'utf8')
const runtimeVersion = serverSource.match(/version:\s*['"]([^'"]+)['"]/)?.[1]
if (runtimeVersion !== packageManifest.version) {
  throw new Error(
    `Runtime version is inconsistent: package.json=${packageManifest.version}, src/server.ts=${runtimeVersion ?? 'missing'}.`
  )
}

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})

if (pack.error) throw pack.error
if (pack.status !== 0) throw new Error(`npm pack failed with exit code ${pack.status ?? 'unknown'}.`)

const packOutput = JSON.parse(pack.stdout) as PackResult[] | Record<string, PackResult>
const result = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0]
if (!result) throw new Error('npm pack did not return package metadata.')
if (result.name !== packageManifest.name || result.version !== packageManifest.version) {
  throw new Error(
    `Packed metadata is inconsistent: expected ${packageManifest.name}@${packageManifest.version}, found ${result.name}@${result.version}.`
  )
}

const packedFiles = new Set(result.files.map((file) => file.path))
const includedExcludedFiles = [...excludedFiles].filter((file) => packedFiles.has(file))
if (includedExcludedFiles.length > 0) {
  throw new Error(`Package includes excluded demo media: ${includedExcludedFiles.join(', ')}.`)
}

const missingRequiredFiles = requiredFiles.filter((file) => !packedFiles.has(file))
if (missingRequiredFiles.length > 0) {
  throw new Error(`Package is missing required files: ${missingRequiredFiles.join(', ')}.`)
}

if (result.size > maximumPackageSize) {
  throw new Error(`Package size ${result.size.toLocaleString()} bytes exceeds the ${maximumPackageSize.toLocaleString()} byte limit.`)
}

console.log(
  JSON.stringify(
    {
      package: `${result.name}@${result.version}`,
      size: result.size,
      maximumSize: maximumPackageSize,
      fileCount: result.files.length,
    },
    null,
    2
  )
)

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as T
}
