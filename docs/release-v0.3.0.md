# codex-tldraw-mcp v0.3.0

Workflow layout update for dense diagrams.

## Changes

- Wraps node and connector text before rendering.
- Sizes nodes from the wrapped text.
- Routes connections through separate lanes around nodes.
- Uses one final arrowhead for each logical connection.
- Adds smoke checks for text fit and connector collisions.

## Compatibility

MCP tool names and inputs are unchanged. A logical connection may now use multiple arrow records in the generated `.tldr` file.

## Verification

```bash
bun run build
bun run smoke
bun run check:package
mcp-publisher validate
```
