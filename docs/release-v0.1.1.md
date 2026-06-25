# codex-tldraw-mcp v0.1.1

Discoverability update for the Codex-first tldraw MCP server.

## Highlights

- Adds GitHub/npm metadata so package pages and MCP directories can link back to the repository, issues, and README.
- Adds `mcpName` and root `server.json` metadata for publishing to the official MCP Registry as `io.github.jananadiw/codex-tldraw-mcp`.
- Moves the README demo image, install command, and generated board path above the compatibility backstory.
- Adds CI for build and smoke-test verification on pushes and pull requests.
- Adds GitHub issue templates for bugs, feature requests, and real-world feedback.
- Keeps the runtime behavior unchanged from `0.1.0`.

## Try It

```bash
codex mcp add codex-tldraw -- npx -y codex-tldraw-mcp
```

```text
Use codex-tldraw to diagram this repo.
```

## Links

- npm: https://www.npmjs.com/package/codex-tldraw-mcp
- GitHub: https://github.com/jananadiw/codex-tldraw-mcp
- MCP Registry name: `io.github.jananadiw/codex-tldraw-mcp`
