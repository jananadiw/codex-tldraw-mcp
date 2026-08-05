# Changelog

## 0.5.0

- Added `draw_architecture` for reverse-engineering runtime behavior across a codebase's main components.
- Put the primary user flow in a straight row and supporting services below the component that calls them.
- Limited components to three actions and two short errors so generated boards stay scannable.
- Combined each request and response into one concise, bound arrow instead of drawing overlapping return paths.
- Stored repository evidence in shape metadata without adding it to the visible diagram.
- Added architecture input documentation and smoke coverage for layout, validation, MCP transport, metadata, and bound endpoints.

## 0.4.0

- Added `diagram_code_graph` for trackable JavaScript and TypeScript module/import diagrams.
- Added `compare_code_graph` with read-only preview and optional drift markers.
- Marked stale graph elements red and changed modules orange while preserving user layout, labels, manual shapes, unrelated diagrams, and each element's prior color for restoration.
- Reported new elements, unresolved relative imports, and external import counts without rearranging the board.
- Added deterministic repository-relative identities and fingerprints without storing absolute paths in shape metadata.
- Used the TypeScript parser for syntax-aware imports, re-exports, dynamic imports, CommonJS `require`, JSX, and regular-expression literals.
- Added lifecycle coverage for preview safety, stale and changed markers, new elements, restoration, idempotency, legacy boards, and user-content preservation.

## 0.3.0

- Wrapped node and connector text before rendering so labels stay readable.
- Routed dense connections through separate lanes to avoid boxes and shared tracks.
- Added smoke checks for text fit, connector collisions, and arrow direction.

## 0.2.1

- Improved generated tldraw diagram readability with adaptive step sizing, wrapped layouts, and cleaner sans-serif labels.
- Kept compact diagrams with six or fewer steps on one row to reduce unnecessary return arrows.
- Updated arrow routing and board bounds calculations to use actual step dimensions.
- Extended smoke coverage for long labels, wrapped rows, adaptive heights, and appended diagram spacing.
- Reduced the npm package by keeping repository-hosted demo media out of the published tarball.
- Added package-content validation and hardened npm publishing through GitHub OIDC trusted publishing.

## 0.2.0

- Added `draw_canvas`, an offline canvas API for prompt-provided tldraw diagrams that do not require repo scanning.
- Added prompt workflow normalization with generated step ids, duplicate-id checks, sequential default arrows, and connection validation.
- Extended smoke coverage for prompt-driven diagrams and invalid connection references.
- Updated README examples for repo-inferred and prompt-driven diagrams.
- Added release notes for the offline canvas API update.

## 0.1.1

- Added npm discovery metadata for repository, homepage, issues, and broader MCP search terms.
- Added `mcpName` and root `server.json` metadata for MCP Registry publishing.
- Reworked the README to lead with the demo image, install command, and user-facing value.
- Added CI for build and smoke-test verification on pushes and pull requests.
- Added GitHub issue templates for bugs, feature requests, and real-world feedback.
- Added GitHub release notes for the discoverability update.

## 0.1.0

- Published the first npm executable for Codex stdio MCP usage.
- Added `diagram_repo`, `list_boards`, and `read_board_summary`.
- Generated repo-local `.tldr` product workflow snapshots under `boards/`.
- Added optional `TLDRAW_MCP_ALLOWED_ROOTS` filesystem allowlisting.
