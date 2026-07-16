# codex-tldraw-mcp v0.4.0

Code graph drift detection for repo-local tldraw boards.

## Highlights

- Adds `diagram_code_graph` for deterministic JavaScript and TypeScript module/import diagrams.
- Adds `compare_code_graph` with a read-only preview and optional board markers.
- Marks stale modules and imports red and changed modules orange.
- Reports new graph elements without rearranging the existing canvas.
- Preserves user positions, sizes, labels, manual shapes, unrelated diagrams, and each element's prior color for restoration.
- Restores the original style when the code matches the stored graph again.
- Uses the TypeScript parser so JSX text, comments, strings, and regular-expression literals do not create false imports.

## How It Works

Generated graph nodes and edges carry stable repository-relative identities and semantic fingerprints. A later scan compares the current modules and local imports with that stored baseline:

- `unchanged`: identity and fingerprint match.
- `changed`: a module remains, but its exports or local import relationships differ.
- `stale`: the board element no longer exists in the current graph.
- `new`: the current graph element is absent from the board.

Preview mode leaves the `.tldr` file untouched. Marker mode updates only MCP-owned graph styles and metadata. It does not insert new elements or change the canvas layout.

## Supported Graphs

The scanner supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts` modules. It follows static imports, dynamic imports, re-exports, and CommonJS `require` calls between repository modules. It reports unresolved relative imports and counts external imports without drawing external packages.

This release models module/import relationships. It does not infer runtime call graphs, and it cannot compare legacy workflow or prompt-generated diagrams that lack code-graph metadata.

## Try It

```text
Use codex-tldraw to create a code graph for this repo.
```

After changing the code:

```text
Use codex-tldraw to preview drift in the newest code graph. If the result looks right, apply the markers.
```

## Verification

```bash
bun install --frozen-lockfile
bun run build
bun run smoke
bun run check:package
mcp-publisher validate
```
