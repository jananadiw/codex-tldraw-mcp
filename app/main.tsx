import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type App,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import {
  OpenAIExtensions,
  OpenAIFileEntrypointInputSchema,
} from '@openai/mcp-extensions/app'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  parseTldrawJsonFile,
  serializeTldrawJson,
  Tldraw,
  type Editor,
  type TLStore,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './app.css'

import { boardResourceUri, parseBoardResourceUri } from '../src/boardResource'

const APP_VERSION = '0.7.0'
const SERVER_BOARD_URI_PATTERN = /^tldraw:\/\/boards\/([^/]+)\/file$/

type HostFileSource = {
  kind: 'host-file'
  name: string
  resourceUri: string
}

type ServerBoardSource = {
  kind: 'server-board'
  boardName: string
  repoPath?: string
  displayName: string
}

type BoardSource = HostFileSource | ServerBoardSource

function BoardApp() {
  const extensions = useRef<OpenAIExtensions | null>(null)
  const appRef = useRef<App | null>(null)
  const [boardSource, setBoardSource] = useState<BoardSource | null>(null)
  const [hostContext, setHostContext] = useState<McpUiHostContext>()
  const [store, setStore] = useState<TLStore | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [etag, setEtag] = useState<string>()
  const [writable, setWritable] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const savingRef = useRef(false)
  const editVersion = useRef(0)
  const currentSource = useRef(boardSource)
  currentSource.current = boardSource
  const [status, setStatus] = useState('Waiting for a .tldr file…')
  const [errorMessage, setErrorMessage] = useState<string>()

  const conflictedRef = useRef(conflicted)
  conflictedRef.current = conflicted
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const acceptToolPayload = useCallback((value: unknown) => {
    const source = parseBoardSource(value)
    if (!source) return
    const current = currentSource.current
    const sameBoard = current?.kind === source.kind && (
      source.kind === 'server-board' && current.kind === 'server-board'
        ? source.repoPath === current.repoPath && source.boardName === current.boardName
        : source.kind === 'host-file' && current.kind === 'host-file' && source.resourceUri === current.resourceUri
    )
    if (sameBoard && savingRef.current) return
    if (sameBoard && dirtyRef.current) {
      setConflicted(true)
      setStatus('Board updated outside this editor. Reload before saving.')
      return
    }
    setBoardSource(source)
  }, [])

  const { app, error } = useApp({
    appInfo: { name: 'codex-tldraw', version: APP_VERSION },
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    onAppCreated: (createdApp) => {
      appRef.current = createdApp
      extensions.current = new OpenAIExtensions(createdApp)
      createdApp.ontoolinput = ({ arguments: args }) => {
        if (args?.file) acceptToolPayload(args)
      }
      createdApp.ontoolresult = (result) => acceptToolPayload(result.structuredContent)
      createdApp.onhostcontextchanged = (context) => {
        applyHostContext(context)
        setHostContext((current) => ({ ...current, ...context }))
      }
      createdApp.onteardown = async () => ({})
      createdApp.onerror = console.error
    },
  })

  useEffect(() => {
    if (!app) return
    appRef.current = app
    const context = app.getHostContext()
    applyHostContext(context)
    setHostContext(context)
  }, [app])

  useEffect(() => {
    if (!app || !boardSource) return

    const target = boardSource
    const connectedApp = app
    let cancelled = false
    async function loadBoard() {
      setErrorMessage(undefined)
      setEditor(null)
      setStore(null)
      setWritable(false)
      setStatus(`Opening ${displayName(target)}…`)

      const json = await readBoardJson(connectedApp, target, extensions.current)
      if (cancelled) return

      const nextStore = parseBoard(json.text)
      if (cancelled) return

      setEditor(null)
      setStore(nextStore)
      setEtag(json.etag)
      setWritable(json.writable)
      setDirty(false)
      setConflicted(false)
      setStatus(json.writable ? 'Ready to edit' : 'Read-only in this host')
    }

    void loadBoard().catch((cause) => {
      if (cancelled) return
      setStore(null)
      setErrorMessage(errorText(cause))
      setStatus('Could not open board')
    })

    return () => {
      cancelled = true
    }
  }, [app, boardSource, reloadVersion])

  const handleMount = useCallback((mountedEditor: Editor) => {
    setEditor(mountedEditor)
    mountedEditor.zoomToFit()
    setDirty(false)
    return mountedEditor.store.listen(
      () => {
        editVersion.current += 1
        setDirty(true)
        setStatus(conflictedRef.current ? 'File changed outside this editor. Reload before saving.' : 'Unsaved changes')
      },
      { scope: 'document', source: 'user' }
    )
  }, [])

  const save = useCallback(async () => {
    if (!editor || !boardSource || !writable || savingRef.current || conflicted) return
    const target = boardSource
    const revision = editVersion.current
    savingRef.current = true
    setSaving(true)
    setStatus('Saving…')
    try {
      const text = await serializeTldrawJson(editor)
      let nextEtag: string | undefined
      if (target.kind === 'server-board') {
        const activeApp = appRef.current
        if (!activeApp) throw new Error('MCP App is not connected.')
        if (!target.repoPath) throw new Error('This older board link has no repository path. Run the diagram tool again to open a new link.')
        const result = await activeApp.callServerTool({
          name: 'save_board',
          arguments: { boardName: target.boardName, repoPath: target.repoPath, tldrJson: text, ifMatch: etag },
        })
        if (result.isError) throw new Error(formatToolError(result))
        const output = result.structuredContent as Record<string, unknown> | undefined
        nextEtag = typeof output?.etag === 'string' ? output.etag : undefined
      } else {
        const resources = extensions.current?.resources
        if (!resources) throw new Error('This host does not provide writable file resources.')
        const result = await resources.write(target.resourceUri, { text, ...(etag ? { ifMatch: etag } : {}) })
        if (result.outcome === 'conflict') throw new Error('File changed outside this editor. Reload before saving.')
        if (result.outcome === 'too-large') throw new Error(`File is too large to save. Limit: ${result.maxBytes.toLocaleString()} bytes.`)
        if (result.outcome !== 'saved') throw new Error('The host did not save this file.')
        nextEtag = result.etag
      }
      if (currentSource.current !== target) return
      setEtag(nextEtag)
      const changed = editVersion.current !== revision
      setDirty(changed)
      setStatus(changed ? 'Unsaved changes' : 'Saved')
    } catch (cause) {
      if (currentSource.current !== target) return
      const message = errorText(cause)
      if (message.includes('Reload before saving')) setConflicted(true)
      setStatus(message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [boardSource, editor, etag, writable, conflicted])

  const connectionError = error ? errorText(error) : undefined
  const visibleError = connectionError ?? errorMessage
  const boardKey =
    boardSource?.kind === 'host-file'
      ? boardSource.resourceUri
      : boardSource
        ? `${boardSource.repoPath}/${boardSource.boardName}`
        : 'idle'

  return (
    <main
      className="app-shell"
      style={{
        paddingTop: hostContext?.safeAreaInsets?.top,
        paddingRight: hostContext?.safeAreaInsets?.right,
        paddingBottom: hostContext?.safeAreaInsets?.bottom,
        paddingLeft: hostContext?.safeAreaInsets?.left,
      }}
    >
      <header className="app-header">
        <div className="app-title">
          <strong>{boardSource ? displayName(boardSource) : 'tldraw board'}</strong>
          <span role="status" aria-live="polite" title={visibleError ?? status}>{visibleError ?? status}</span>
        </div>
        <button
          className="save-button"
          type="button"
          disabled={!boardSource || saving}
          title={dirty ? 'Reload the board and discard unsaved changes' : 'Reload the board'}
          onClick={() => setReloadVersion((value) => value + 1)}
        >
          {dirty ? 'Discard and reload' : 'Reload'}
        </button>
        <button
          className="save-button"
          type="button"
          disabled={!dirty || !writable || !editor || saving || conflicted}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>
      <section className="editor-frame">
        {visibleError ? (
          <div className="centered-message error">{visibleError}</div>
        ) : store ? (
          <Tldraw key={boardKey} store={store} onMount={handleMount} />
        ) : (
          <div className="centered-message">{status}</div>
        )}
      </section>
    </main>
  )
}

function parseBoardSource(value: unknown): BoardSource | null {
  const fileEntrypoint = OpenAIFileEntrypointInputSchema.safeParse(value)
  if (fileEntrypoint.success) {
    const { name, resourceUri } = fileEntrypoint.data.file
    const scoped = parseBoardResourceUri(resourceUri)
    if (scoped?.kind === 'file') {
      return { kind: 'server-board', boardName: scoped.boardName, repoPath: scoped.repoPath, displayName: name }
    }
    const serverMatch = resourceUri.match(SERVER_BOARD_URI_PATTERN)
    if (serverMatch) {
      return {
        kind: 'server-board',
        boardName: decodeURIComponent(serverMatch[1]),
        displayName: name,
      }
    }
    return { kind: 'host-file', name, resourceUri }
  }

  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.boardName === 'string') {
    return {
      kind: 'server-board',
      boardName: record.boardName,
      repoPath: typeof record.repoPath === 'string' ? record.repoPath : undefined,
      displayName: `${record.boardName}.tldr`,
    }
  }

  const nestedFile = record.file
  if (nestedFile && typeof nestedFile === 'object') {
    return parseBoardSource({ file: nestedFile })
  }

  return null
}

async function readBoardJson(
  app: App,
  source: BoardSource,
  extensions: OpenAIExtensions | null
): Promise<{ text: string; writable: boolean; etag?: string }> {
  if (source.kind === 'server-board') {
    if (!source.repoPath) throw new Error('This older board link has no repository path. Run the diagram tool again to open a new link.')
    const uri = boardResourceUri(source.repoPath, source.boardName)
    const result = await app.readServerResource({ uri })
    const content = result.contents.find((candidate) => candidate.uri === uri) ?? result.contents[0]
    if (!content) throw new Error('The MCP server returned no board content.')
    const text = resourceText(content)
    const metadata = content._meta as Record<string, unknown> | undefined
    return { text, writable: true, etag: typeof metadata?.etag === 'string' ? metadata.etag : undefined }
  }

  const resources = extensions?.resources
  if (!resources) {
    throw new Error('This host does not provide file resource access.')
  }

  const result = await resources.read({
    uri: source.resourceUri,
    representation: 'text',
  })
  const content =
    result.contents.find((candidate) => candidate.uri === source.resourceUri) ?? result.contents[0]
  if (!content) throw new Error('The host returned no file content.')

  return {
    text: resourceText(content),
    etag: content.openaiMetadata?.etag,
    writable: content.openaiMetadata?.writable === true,
  }
}

function resourceText(content: { text?: string; blob?: string }) {
  if ('text' in content && typeof content.text === 'string') return content.text
  if ('blob' in content && typeof content.blob === 'string') {
    return new TextDecoder().decode(Uint8Array.from(atob(content.blob), (char) => char.charCodeAt(0)))
  }
  throw new Error('Resource content is not readable text.')
}

function displayName(source: BoardSource) {
  return source.kind === 'host-file' ? source.name : source.displayName
}

function formatToolError(result: { content?: Array<{ type: string; text?: string }> }) {
  const message = result.content
    ?.map((part) => (part.type === 'text' ? part.text : undefined))
    .filter(Boolean)
    .join('\n')
  return message || 'save_board failed.'
}

function parseBoard(json: string) {
  const emptyStore = createTLStore({
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
  })
  const result = parseTldrawJsonFile({ json, schema: emptyStore.schema })
  if (!result.ok) {
    throw new Error(`Invalid tldraw file: ${result.error.type}`)
  }
  return result.value
}

function applyHostContext(context: McpUiHostContext | undefined) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
}

function errorText(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('ENOENT')) return 'The board file was not found. Create the diagram again or open an existing .tldr file.'
  return message
}

createRoot(document.getElementById('root')!).render(<BoardApp />)
