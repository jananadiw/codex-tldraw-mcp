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
  const [status, setStatus] = useState('Waiting for a .tldr file…')
  const [errorMessage, setErrorMessage] = useState<string>()

  const acceptToolPayload = useCallback((value: unknown) => {
    const source = parseBoardSource(value)
    if (source) setBoardSource(source)
  }, [])

  const { app, error } = useApp({
    appInfo: { name: 'codex-tldraw', version: APP_VERSION },
    capabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    onAppCreated: (createdApp) => {
      appRef.current = createdApp
      extensions.current = new OpenAIExtensions(createdApp)
      createdApp.ontoolinput = ({ arguments: args }) => acceptToolPayload(args)
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
  }, [app, boardSource])

  const handleMount = useCallback((mountedEditor: Editor) => {
    setEditor(mountedEditor)
    mountedEditor.zoomToFit()
    setDirty(false)
    return mountedEditor.store.listen(
      () => {
        setDirty(true)
        setStatus('Unsaved changes')
      },
      { scope: 'document', source: 'user' }
    )
  }, [])

  const save = useCallback(async () => {
    if (!editor || !boardSource || !writable) return

    if (boardSource.kind === 'server-board') {
      const activeApp = appRef.current
      if (!activeApp) throw new Error('MCP App is not connected.')

      setStatus('Saving…')
      const tldrJson = await serializeTldrawJson(editor)
      const result = await activeApp.callServerTool({
        name: 'save_board',
        arguments: {
          boardName: boardSource.boardName,
          ...(boardSource.repoPath ? { repoPath: boardSource.repoPath } : {}),
          tldrJson,
        },
      })
      if (result.isError) {
        throw new Error(formatToolError(result))
      }
      setDirty(false)
      setStatus('Saved')
      return
    }

    const resources = extensions.current?.resources
    if (!resources) throw new Error('This host does not provide writable file resources.')

    setStatus('Saving…')
    const text = await serializeTldrawJson(editor)
    const result = await resources.write(boardSource.resourceUri, {
      text,
      ...(etag ? { ifMatch: etag } : {}),
    })

    if (result.outcome === 'saved') {
      setEtag(result.etag)
      setDirty(false)
      setStatus('Saved')
      return
    }
    if (result.outcome === 'conflict') {
      setEtag(result.etag)
      setStatus('File changed outside Codex. Reload before saving.')
      return
    }
    if (result.outcome === 'too-large') {
      setStatus(`File is too large to save. Limit: ${result.maxBytes.toLocaleString()} bytes.`)
    }
  }, [boardSource, editor, etag, writable])

  const connectionError = error ? errorText(error) : undefined
  const visibleError = connectionError ?? errorMessage
  const boardKey =
    boardSource?.kind === 'host-file'
      ? boardSource.resourceUri
      : boardSource
        ? `tldraw://${boardSource.boardName}`
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
          <span>{visibleError ?? status}</span>
        </div>
        <button
          className="save-button"
          type="button"
          disabled={!dirty || !writable || !editor}
          onClick={() => void save().catch((cause) => setStatus(errorText(cause)))}
        >
          Save
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
    const uri = `tldraw://boards/${source.boardName}/file`
    const result = await app.readServerResource({ uri })
    const content = result.contents.find((candidate) => candidate.uri === uri) ?? result.contents[0]
    if (!content) throw new Error('The MCP server returned no board content.')
    const text = resourceText(content)
    return { text, writable: true }
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
  return cause instanceof Error ? cause.message : String(cause)
}

createRoot(document.getElementById('root')!).render(<BoardApp />)
