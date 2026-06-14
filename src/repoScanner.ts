import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProductWorkflow, WorkflowConnection, WorkflowStep } from './types.js'

const MAX_FILES = 500
const MAX_TEXT_FILES = 120
const MAX_TEXT_BYTES = 20_000
const IGNORE_DIRS = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'out',
  'target',
  '.turbo',
])
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
])

export async function scanRepo(repoPath: string): Promise<ProductWorkflow> {
  const root = path.resolve(repoPath)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error(`Repo path is not a directory: ${root}`)

  const files = await walk(root)
  const packageJson = await readPackageJson(root)
  const repoName = packageJson?.name ?? path.basename(root)
  const sourceText = await readSearchableText(root, files, packageJson)
  const steps = buildWorkflowSteps(repoName, sourceText)
  const connections = buildConnections(steps)

  return {
    repoName,
    repoPath: root,
    steps,
    connections,
  }
}

async function walk(root: string) {
  const results: string[] = []

  async function visit(dir: string) {
    if (results.length >= MAX_FILES) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (results.length >= MAX_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(root, fullPath)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await visit(fullPath)
      } else if (entry.isFile()) {
        results.push(relativePath)
      }
    }
  }

  await visit(root)
  return results
}

async function readPackageJson(root: string) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      name?: string
      description?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
  } catch {
    return null
  }
}

async function readSearchableText(
  root: string,
  files: string[],
  packageJson: Awaited<ReturnType<typeof readPackageJson>>
) {
  const parts = [
    packageJson?.name,
    packageJson?.description,
    Object.keys(packageJson?.dependencies ?? {}).join(' '),
    Object.keys(packageJson?.devDependencies ?? {}).join(' '),
  ].filter(Boolean)

  const textFiles = files.filter(isTextFile).slice(0, MAX_TEXT_FILES)
  for (const file of textFiles) {
    try {
      const contents = await fs.readFile(path.join(root, file), 'utf8')
      parts.push(file, contents.slice(0, MAX_TEXT_BYTES))
    } catch {
      parts.push(file)
    }
  }

  return parts.join('\n').toLowerCase()
}

function isTextFile(file: string) {
  return TEXT_EXTENSIONS.has(path.extname(file))
}

function buildWorkflowSteps(repoName: string, sourceText: string): WorkflowStep[] {
  const signals = detectSignals(repoName, sourceText)

  if (signals.handwriting && signals.font && (signals.photo || signals.paper) && signals.upload) {
    return [
      step('write-alphabet', 'User writes alphabet on paper', evidence(signals, ['handwriting', 'paper'])),
      step('take-photo', 'User takes a photo of the paper', evidence(signals, ['photo'])),
      step('upload-photo', 'User uploads the image', evidence(signals, ['upload', 'image'])),
      step('generate-font', 'AI generates a font', evidence(signals, ['ai', 'generate', 'font'])),
      step('download-font', 'User downloads a .ttf file', evidence(signals, ['download', 'ttf'])),
    ]
  }

  if (signals.upload || signals.image || signals.file) {
    const inputLabel = signals.image ? 'User selects an image' : 'User selects a file'
    const outputLabel = outputStepLabel(signals)
    return [
      step('open-app', `User opens ${displayName(repoName)}`, evidence(signals, ['app'])),
      step('choose-input', inputLabel, evidence(signals, ['upload', 'image', 'file'])),
      step('process-input', processingStepLabel(signals), evidence(signals, ['ai', 'generate', 'process', 'font'])),
      step('get-output', outputLabel, evidence(signals, ['download', 'ttf', 'export'])),
    ]
  }

  return [
    step('open-app', `User opens ${displayName(repoName)}`, evidence(signals, ['app'])),
    step('complete-task', 'User completes the main task', evidence(signals, ['feature'])),
    step('review-result', 'User reviews the result', evidence(signals, ['result'])),
  ]
}

function detectSignals(repoName: string, sourceText: string) {
  const haystack = `${repoName}\n${sourceText}`
  return {
    ai: hasAny(haystack, ['ai', 'openai', 'model', 'llm', 'generate', 'generated', 'generation']),
    app: hasAny(haystack, ['app', 'application', 'page', 'user']),
    download: hasAny(haystack, ['download', 'downloaded', 'save as', 'export']),
    export: hasAny(haystack, ['export', 'download', 'save']),
    feature: hasAny(haystack, ['feature', 'workflow', 'user']),
    file: hasAny(haystack, ['file', 'files', 'blob', 'formdata']),
    font: hasAny(haystack, ['font', 'fonts', 'glyph', 'glyphs', 'typeface', 'opentype']),
    generate: hasAny(haystack, ['generate', 'generated', 'generation', 'create', 'convert']),
    handwriting: hasAny(haystack, ['handwrite', 'handwriting', 'handwritten', 'write alphabet', 'alphabet']),
    image: hasAny(haystack, ['image', 'images', 'photo', 'picture', 'png', 'jpg', 'jpeg']),
    paper: hasAny(haystack, ['paper', 'sheet', 'worksheet', 'alphabet']),
    photo: hasAny(haystack, ['photo', 'camera', 'picture', 'scan', 'scanner']),
    process: hasAny(haystack, ['process', 'convert', 'transform', 'analyze']),
    result: hasAny(haystack, ['result', 'output', 'preview']),
    ttf: hasAny(haystack, ['.ttf', 'ttf', 'truetype']),
    upload: hasAny(haystack, ['upload', 'uploads', 'uploaded', 'dropzone', 'input type="file"', 'formdata']),
  }
}

function hasAny(haystack: string, needles: string[]) {
  return needles.some((needle) => haystack.includes(needle))
}

function step(id: string, label: string, evidence: string[], detail?: string): WorkflowStep {
  return {
    id,
    label,
    detail,
    evidence,
  }
}

function evidence(signals: ReturnType<typeof detectSignals>, names: Array<keyof ReturnType<typeof detectSignals>>) {
  return names.filter((name) => signals[name])
}

function processingStepLabel(signals: ReturnType<typeof detectSignals>) {
  if (signals.ai && signals.font) return 'AI generates a font'
  if (signals.ai) return 'AI generates the result'
  if (signals.font) return 'App creates the font'
  return 'App processes the input'
}

function outputStepLabel(signals: ReturnType<typeof detectSignals>) {
  if (signals.download && signals.ttf) return 'User downloads a .ttf file'
  if (signals.download) return 'User downloads the result'
  if (signals.export) return 'User exports the result'
  return 'User reviews the result'
}

function buildConnections(steps: WorkflowStep[]) {
  const connections: WorkflowConnection[] = []
  for (let index = 0; index < steps.length - 1; index += 1) {
    connections.push({
      from: steps[index].id,
      to: steps[index + 1].id,
      label: '',
    })
  }
  return connections
}

function displayName(repoName: string) {
  return repoName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
