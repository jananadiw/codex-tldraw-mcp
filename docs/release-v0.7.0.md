# codex-tldraw-mcp v0.7.0

Codex plugin with an editable tldraw MCP App.

## Highlights

- Ships `.codex-plugin/plugin.json`, `.mcp.json`, and a bundled `dist/app.html` MCP App.
- Opens `.tldraw` files in Codex through the `open_tldraw_file` entrypoint when the host provides file resources.
- Opens boards inline after diagram tools via `tldraw://boards/{name}/file` and app-only `save_board`.
- Keeps the existing stdio MCP tools, SVG previews, and resource links for non-app hosts.

## Install the Codex plugin

From the published npm package (recommended):

```bash
npm install -g codex-tldraw-mcp@0.7.0
codex plugin marketplace add "$(npm root -g)/codex-tldraw-mcp"
codex plugin add codex-tldraw@codex-tldraw-mcp
```

From this Git repository (builds on first install if `dist/` is missing):

```bash
codex plugin marketplace add jananadiw/codex-tldraw-mcp
codex plugin add codex-tldraw@codex-tldraw-mcp
```

## Compatibility

Existing MCP-only setups (`npx codex-tldraw-mcp`, local `node dist/index.js`) are unchanged. The plugin MCP server name is `codex-tldraw-app` to avoid colliding with other tldraw MCP registrations.

## Verification

```bash
bun install --frozen-lockfile
bun run build
bun run smoke
bun run check:package
mcp-publisher validate
```
