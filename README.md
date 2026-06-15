# codex-tldraw-mcp

A Codex stdio MCP server that generates simple tldraw product workflow diagrams as `.tldr` files.

This project is snapshot-only. It does not control a live browser canvas or provide live collaboration. It writes board files to the repository being diagrammed so a tldraw-compatible viewer can open them later.

## Why This Exists

The official tldraw MCP App is designed for hosts that can render an interactive tldraw canvas inside the chat context. In Codex Desktop, tool discovery worked in testing, and the tldraw `search` tool returned Editor API details, shape types, and helpers. The live `exec` path did not work: every call timed out after 30 seconds, including a read-only call to count the current page shapes.

That failure mode suggested a host compatibility gap, not a tldraw file format problem. Codex can reliably call local stdio MCP tools and inspect generated files, but it does not currently provide the same embedded interactive MCP App canvas path used by hosts such as Cursor.

This server is the Codex-first fallback we decided to build. Instead of trying to drive a live canvas, it generates `.tldr` snapshots on disk through a normal stdio MCP tool call. The result is less interactive, but it works reliably in Codex and keeps the generated board with the repository it explains.

## Add To Codex

```bash
codex mcp add codex-tldraw -- npx -y codex-tldraw-mcp
```

Then ask Codex to use `codex-tldraw` and call `diagram_repo`.

Example prompt:

```text
Use codex-tldraw to diagram this repo.
```

For manual Codex stdio MCP configuration:

```toml
[mcp_servers.codex-tldraw]
command = "npx"
args = ["-y", "codex-tldraw-mcp"]
```

## What It Does

- Scans a local repo from package metadata and source text.
- Infers a simple user-facing product workflow.
- Draws that workflow as tldraw steps and arrows.
- Appends a new diagram to the right when the board already contains shapes.
- Exposes board summaries as MCP resources.

## Output

The default board is:

```text
<repo>/boards/main.tldr
```

If `main.tldr` is empty or missing, `diagram_repo` creates the first diagram near the canvas origin. If it already has shapes, `diagram_repo` appends the next diagram to the right of the existing content instead of clearing the board.

## Tools

- `diagram_repo`: scans a repo and appends a product workflow diagram to `<repo>/boards/<boardName>.tldr`.
- `list_boards`: lists boards under a repo's `boards/` directory.
- `read_board_summary`: summarizes generated diagrams and shape counts.

Each tool accepts an optional `repoPath`. Relative paths are resolved from the MCP server working directory.

Board resources list and read boards from the most recent `repoPath` used by a tool call. Before any tool call, resources default to the MCP server working directory.

## Security

This is a local filesystem tool. It reads source files from `repoPath` and writes `.tldr` files under `repoPath/boards`.

To restrict access to specific directories, set `TLDRAW_MCP_ALLOWED_ROOTS` to a path-delimited allowlist:

```toml
[mcp_servers.codex-tldraw]
command = "npx"
args = ["-y", "codex-tldraw-mcp"]
env = { TLDRAW_MCP_ALLOWED_ROOTS = "/Users/me/dev:/Users/me/work" }
```

When the allowlist is set, `repoPath` must resolve inside one of those roots.

Generated `.tldr` files do not store absolute local repository paths in shape metadata.

## Local Development

This repo uses Bun for development:

```bash
bun install
bun run build
bun run smoke
```

Run the server from source:

```bash
bun run dev
```

Use a local build in Codex:

```toml
[mcp_servers.codex-tldraw]
command = "node"
args = ["/absolute/path/to/codex-tldraw-mcp/dist/index.js"]
```

## Publish

Build, test, inspect the package contents, then publish:

```bash
bun install
bun run build
bun run smoke
bun publish --dry-run
bun publish --access public
```

For a handwriting font app, the workflow may be inferred as:

```text
User writes alphabet on paper -> User takes a photo of the paper -> User uploads the image -> AI generates a font -> User downloads a .ttf file
```
