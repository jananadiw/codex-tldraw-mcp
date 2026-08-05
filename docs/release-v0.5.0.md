# codex-tldraw-mcp v0.5.0

Simple runtime architecture diagrams for understanding unfamiliar codebases.

## Highlights

- Adds `draw_architecture`, a focused MCP tool for reverse-engineering behavior across browser, API, worker, data store, queue, and external-service boundaries.
- Shows the primary user flow as a straight row and places supporting services below the component that calls them.
- Keeps diagrams readable with at most three actions and two short errors per component.
- Uses one concise arrow per interaction, combining request and response instead of drawing overlapping return paths.
- Keeps source evidence in shape metadata so the visible board stays clean.
- Binds every meaningful arrow to both endpoint shapes and separates support-service ports to prevent shared tracks.

## Input Model

The caller supplies:

- `components`: two to seven runtime components with short actions and optional errors.
- `primaryFlow`: two to four component ids ordered from the user's first action to the final result.
- `connections`: one short call or data-transfer label per component interaction.

See [Simple Architecture Diagrams](architecture-diagrams.md) for the complete contract and example.

## Try It

```text
Use codex-tldraw to show how this repo works across its main components.
Show the main flow first, keep short errors inside components, and label each interaction once.
```

The generated board is written to:

```text
<repo>/boards/main.tldr
```

## Compatibility

Existing workflow, prompt-driven canvas, and code-graph tools are unchanged. `draw_architecture` is a new tool and requires callers to provide its `primaryFlow` field.

## Verification

```bash
bun install --frozen-lockfile
bun run build
bun run smoke
bun run check:package
mcp-publisher validate
```
