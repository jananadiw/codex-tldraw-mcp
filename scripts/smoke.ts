import fs from 'node:fs/promises'
import { appendWorkflowDiagram, loadBoard, saveBoard, summarizeBoard } from '../src/tldrawBoard.js'
import { scanRepo } from '../src/repoScanner.js'

const boardName = `smoke-${Date.now().toString(36)}`
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

if (!Array.isArray(raw.records)) throw new Error('Smoke board did not write a tldraw records array.')
if (summary.diagrams.length !== 2) throw new Error(`Expected 2 diagrams, found ${summary.diagrams.length}.`)
if (!second.appended) throw new Error('Second diagram was not marked as appended.')

console.log(
  JSON.stringify(
    {
      boardName,
      boardPath,
      firstDiagram: first.diagramId,
      secondDiagram: second.diagramId,
      shapeCount: summary.shapeCount,
      records: raw.records.length,
    },
    null,
    2
  )
)

if (!process.env.TLDRAW_MCP_KEEP_SMOKE_BOARD) {
  await fs.rm(boardPath, { force: true })
}

process.exit(0)
