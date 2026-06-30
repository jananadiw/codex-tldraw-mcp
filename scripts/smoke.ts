import fs from 'node:fs/promises'
import { appendWorkflowDiagram, loadBoard, saveBoard, summarizeBoard } from '../src/tldrawBoard.js'
import { scanRepo } from '../src/repoScanner.js'
import { buildPromptWorkflow } from '../src/promptWorkflow.js'

const boardName = `smoke-${Date.now().toString(36)}`
const promptBoardName = `${boardName}-prompt`
const workflow = await scanRepo(process.cwd())
const boardRoot = workflow.repoPath

const firstStore = await loadBoard(boardName, boardRoot)
const first = appendWorkflowDiagram(firstStore, workflow)
await saveBoard(boardName, firstStore, boardRoot)

const secondStore = await loadBoard(boardName, boardRoot)
const second = appendWorkflowDiagram(secondStore, workflow)
const boardPath = await saveBoard(boardName, secondStore, boardRoot)

const summary = await summarizeBoard(boardName, boardRoot)
const raw = JSON.parse(await fs.readFile(boardPath, 'utf8')) as { records?: unknown[] }
const promptWorkflow = buildPromptWorkflow(
  'Password reset state machine',
  boardRoot,
  [
    { label: 'User requests reset' },
    { label: 'Email sent' },
    { label: 'Token verified' },
    { label: 'Password updated' },
  ]
)
const promptStore = await loadBoard(promptBoardName, boardRoot)
const promptDiagram = appendWorkflowDiagram(promptStore, promptWorkflow)
const promptBoardPath = await saveBoard(promptBoardName, promptStore, boardRoot)
const promptSummary = await summarizeBoard(promptBoardName, boardRoot)

try {
  buildPromptWorkflow('Invalid prompt workflow', boardRoot, [{ id: 'known', label: 'Known' }], [
    { from: 'known', to: 'missing' },
  ])
  throw new Error('Expected prompt workflow validation to reject unknown connection references.')
} catch (error) {
  if (!String((error as Error).message).includes('unknown to step')) throw error
}

try {
  buildPromptWorkflow('   ', boardRoot, [{ label: 'Known' }])
  throw new Error('Expected prompt workflow validation to reject empty titles.')
} catch (error) {
  if (!String((error as Error).message).includes('title cannot be empty')) throw error
}

if (!Array.isArray(raw.records)) throw new Error('Smoke board did not write a tldraw records array.')
if (summary.diagrams.length !== 2) throw new Error(`Expected 2 diagrams, found ${summary.diagrams.length}.`)
if (!second.appended) throw new Error('Second diagram was not marked as appended.')
if (promptWorkflow.connections.length !== 3) throw new Error('Prompt workflow did not create sequential connections.')
if (promptSummary.diagrams.length !== 1) throw new Error(`Expected 1 prompt diagram, found ${promptSummary.diagrams.length}.`)

console.log(
  JSON.stringify(
    {
      boardName,
      boardPath,
      firstDiagram: first.diagramId,
      secondDiagram: second.diagramId,
      promptBoardPath,
      promptDiagram: promptDiagram.diagramId,
      shapeCount: summary.shapeCount,
      promptShapeCount: promptSummary.shapeCount,
      records: raw.records.length,
    },
    null,
    2
  )
)

if (!process.env.TLDRAW_MCP_KEEP_SMOKE_BOARD) {
  await fs.rm(boardPath, { force: true })
  await fs.rm(promptBoardPath, { force: true })
}

process.exit(0)
