# Changelog

## Unreleased

## 0.7.0

- Added Codex plugin packaging and a `.tldr` file entrypoint.
- Added a sandboxed React/tldraw MCP App that reads host-managed files and saves writable files with ETag conflict protection.
- Kept the existing stdio tools and text/SVG fallbacks for hosts without MCP App support.
- Added build, type-check, smoke, and package-content coverage for the bundled app.
- Fixed MCP App loading after diagram tools by reading `tldraw://boards/.../file` through the host-proxied server resource API instead of requiring OpenAI file resources.
- Added app-only `save_board` and linked diagram tools to the bundled editor via `_meta.ui.resourceUri`.
- Added `prepare` so Git or npm plugin installs build `dist/` when artifacts are missing.

## 0.6.0

- Exported a portable `.svg` preview beside every saved `.tldr` board without adding a browser runtime or dependency.
- Returned the SVG path and MCP resource link from diagram tools so any MCP host can display or attach the result.
- Added an SVG board resource with the standard `image/svg+xml` media type.
- Kept code graph drift previews read-only while refreshing both artifacts when markers are applied.
- Added smoke coverage for SVG creation, append refreshes, MCP transport metadata, and drift behavior.

## 0.5.0

- Added `draw_architecture` for reverse-engineering runtime behavior across a codebase's main components.
- Put the primary user flow in a straight row and supporting services below the component that calls them.
- Limited components to three actions and two short errors so generated boards stay scannable.
- Combined each request and response into one concise, bound arrow instead of drawing overlapping return paths.
- Stored repository evidence in shape metadata without adding it to the visible diagram.
- Added architecture input documentation and smoke coverage for layout, validation, MCP transport, metadata, and bound endpoints.

## 0.4.0

- Added `diagram_code_graph` and `compare_code_graph` for trackable JavaScript and TypeScript module graphs.
- Stored graph snapshots in board metadata and highlighted stale, changed, and new elements during drift detection.
- Added smoke coverage for graph generation, drift preview, and marker application.

## 0.3.0

- Added `draw_canvas` for prompt-provided workflows without scanning repository source.
- Improved workflow layout spacing and sequential connection rendering.
- Added smoke coverage for prompt-driven diagrams.

## 0.2.1

- Fixed MCP transport compatibility issues discovered during registry validation.

## 0.2.0

- Added repo scanning via `diagram_repo` and board append behavior instead of clearing the canvas.
- Added MCP resources for board files, summaries, and previews.

## 0.1.1

- Initial public release with stdio MCP server and local `.tldr` board generation.
