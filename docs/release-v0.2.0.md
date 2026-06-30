# codex-tldraw-mcp v0.2.0

Offline canvas API update for Codex-first tldraw diagrams.

## Highlights

- Adds `draw_canvas`, a new MCP tool for drawing prompt-provided workflows, state machines, architecture sketches, and plans.
- Keeps `diagram_repo` for repo-inferred product workflow diagrams.
- Stores every generated diagram as a repo-local `.tldr` snapshot under `boards/`.
- Appends new diagrams to the right of existing board content instead of clearing the board.
- Generates stable step ids from labels when callers do not provide ids.
- Validates duplicate step ids and connection references before writing the board.

## Why This Matters

The project started as a Codex-first fallback for environments where live embedded tldraw canvas control is unavailable or unreliable. `draw_canvas` keeps that reliability while expanding the use case beyond repo scanning: users can now ask Codex to draw any described flow into a tldraw-compatible board file.

## Try It

```bash
codex mcp add codex-tldraw -- npx -y codex-tldraw-mcp
```

```text
Use codex-tldraw to draw a password reset state machine:
Idle -> Reset requested -> Email sent -> Token verified -> Password updated.
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
