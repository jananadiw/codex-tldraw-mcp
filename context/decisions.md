# Decisions

## Snapshot-only MVP

- Decision: Build a stdio MCP server that writes `.tldr` board files, not a live collaborative canvas.
- Reason: Codex can reliably call local tools and inspect files; live browser control adds WebSocket and host-support complexity.
- Impact: Diagrams are generated as snapshots under `boards/`; opening or rendering them is separate from the MCP call.
- Revisit: Add a live bridge after the snapshot workflow is stable.

## Append Instead of Clear

- Decision: When a board already has shapes, append the next diagram to the right.
- Reason: This avoids destructive edits and matches repeated Codex diagram requests.
- Impact: Multiple diagrams can coexist on one infinite canvas.
- Revisit: Add explicit `replace` or `new_page` modes when users need stricter canvas control.

## Product Workflow Diagrams

- Decision: Diagram what the product does for users instead of drawing repo structure.
- Reason: Product workflows are more useful for explaining app behavior in tldraw.
- Impact: `diagram_repo` now infers user-facing steps from repo text and renders them left to right.
- Revisit: Add a separate architecture mode if users need implementation diagrams again.

## Codex-First Distribution

- Decision: Publish as an npm executable MCP server while using Bun for local development.
- Reason: Codex users can add the server with `npx` without cloning or building the repo.
- Impact: Package metadata, docs, and publish checks optimize for a `bin` entry and npm package contents, not library imports.
- Revisit: Add another distribution path only if Codex gains a simpler native MCP registry flow.

## MCP Registry Metadata

- Decision: Use `io.github.jananadiw/codex-tldraw-mcp` as the MCP Registry name and keep root `server.json` metadata in the repo.
- Reason: The official registry verifies npm package metadata against `mcpName`, and the GitHub namespace improves discovery through MCP aggregators.
- Impact: Registry publishing needs package and `server.json` versions to stay in sync with npm releases; the first registry-ready package is `0.1.1` because `0.1.0` was already published without `mcpName`.
- Revisit: Switch namespaces only if the project moves to an organization or custom domain.

## Repo-Local Board Output

- Decision: Write generated boards to the repository being diagrammed instead of this MCP server repo.
- Reason: User artifacts belong with the project being explained, and `npx` installs should not accumulate generated files.
- Impact: `diagram_repo`, `list_boards`, and `read_board_summary` accept `repoPath` and use `<repo>/boards`.
- Revisit: Add an explicit `outputPath` option if users need centralized board storage.

## Prompt-Driven Offline Canvas API

- Decision: Add `draw_canvas` for prompt-provided diagrams while keeping `.tldr` snapshot output.
- Reason: Users need state machines, plans, and architecture sketches that are not inferred from repo files, and Codex still lacks the live embedded tldraw canvas path this project avoids.
- Impact: The repo remains the storage location, but diagram content can come entirely from the user prompt.
- Revisit: Add edit/delete canvas operations if users need iterative updates to existing shapes instead of appending new diagrams.

## Adaptive Workflow Layout

- Decision: Size workflow step boxes from label/detail length and wrap diagrams into rows instead of rendering every step as a fixed-size single row.
- Reason: Fixed boxes made long labels and dense workflows overlap visually in tldraw.
- Impact: Generated boards are taller but more readable, with arrow endpoints based on actual step bounds.
- Revisit: Add a graph layout library if branching state machines need smarter routing than deterministic rows.

## Reserved Connector Routing Lanes

- Decision: Pre-wrap node text and route non-local connections through distinct row gutters and outer lanes using axis-aligned arrow segments.
- Reason: Render-time text wrapping and shared elbow midpoints caused labels to escape boxes and dense workflow arrows to overlap or cross nodes.
- Impact: Dense diagrams use more canvas space and a logical connection may contain multiple arrow shapes, but text remains contained and direction is shown by one final arrowhead.
- Revisit: Replace deterministic lanes with a graph-routing library if diagrams need automatic crossing minimization or interactive edge editing.

## Optional Filesystem Allowlist

- Decision: Support `TLDRAW_MCP_ALLOWED_ROOTS` to restrict readable and writable repository roots.
- Reason: The server intentionally reads local source files; published tooling should provide an easy hardening path.
- Impact: Default local use remains frictionless, while security-conscious users can constrain access.
- Revisit: Make an allowlist mandatory only if Codex MCP defaults move toward stricter sandboxing.

## Release Distribution Pipeline

- Decision: Keep demo media in the GitHub repository but out of npm, publish npm releases through GitHub OIDC, and publish MCP Registry metadata only after npm is available.
- Reason: Demo media dominated the package size, token-based npm publishing adds avoidable secret management, and the registry verifies the referenced npm version.
- Impact: Release checks enforce a small complete tarball; GitHub Releases trigger npm publishing before maintainers run `mcp-publisher`.
- Revisit: Reconsider the media strategy if npm supports external package assets or automate registry publishing when its authentication supports a safe unattended workflow.

## Trackable Code Graphs

- Decision: Add a separate JavaScript and TypeScript module/import graph with stable repository-relative metadata and preview-first drift comparison.
- Reason: Product workflows cannot reliably identify stale source modules or imports, while deterministic code identities can keep repo-local diagrams useful after code changes.
- Impact: `diagram_code_graph` creates trackable boards; `compare_code_graph` reports unchanged, changed, stale, and new elements and can style existing generated shapes without moving or rewriting them.
- Revisit: Add layout-preserving insertion or baseline refresh when users need new graph elements placed automatically.

## Simple Architecture Model

- Decision: Render an explicit main flow, put support services below it, and keep errors inside components.
- Reason: Bidirectional calls and long messages obscure the user journey when every detail becomes an arrow.
- Impact: Components show at most three actions and two errors; each interaction has one short request/response label; evidence stays in metadata.
- Revisit: Add one field only when real diagrams repeatedly cannot explain an important flow without it.

## Portable SVG Projection

- Decision: Save a dependency-free SVG preview beside every editable `.tldr` board.
- Reason: MCP hosts and review tools can display SVG without understanding tldraw's file format.
- Impact: Board writes return both paths and resource links; SVG covers the shapes generated by this server.
- Revisit: Use tldraw's native exporter if it gains a supported headless Node path.
