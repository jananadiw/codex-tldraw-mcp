# codex-tldraw-mcp v0.2.1

Diagram readability update for generated tldraw boards.

## Highlights

- Sizes workflow boxes from their label and detail text instead of forcing every step into a fixed rectangle.
- Uses readable sans-serif text for generated titles, step labels, and arrow labels.
- Wraps larger diagrams into rows while keeping compact diagrams with six or fewer steps on a single row.
- Routes arrows from actual step bounds so resized boxes still connect cleanly.
- Improves appended diagram spacing by calculating board bounds from real shape and arrow endpoints.

## Why This Matters

Generated architecture diagrams could become difficult to read when labels were long or when workflows had many implementation-level connections. This release makes the default `.tldr` output cleaner, especially for prompt-driven architecture sketches and repo-derived diagrams with longer step details.

## Try It

```bash
codex mcp add codex-tldraw -- npx -y codex-tldraw-mcp
```

```text
Use codex-tldraw to draw the runtime architecture:
Menu bar app -> Scheduler -> Snapshot capture -> Vision analysis -> App state -> User alert
```

The generated board is written to:

```text
<repo>/boards/main.tldr
```

## Verification

```bash
bun run build
bun run smoke
npm publish --access public --dry-run
```

## Links

- npm: https://www.npmjs.com/package/codex-tldraw-mcp
- GitHub: https://github.com/jananadiw/codex-tldraw-mcp
- MCP Registry name: `io.github.jananadiw/codex-tldraw-mcp`
