# codex-tldraw-mcp v0.7.1

Fixes diagram generation and editor loading in fresh plugin installations.

- Pins tldraw to 5.1.1 so generated rectangle properties match the server and bundled editor schema.
- Adds a Node launcher with a matching npm fallback for source-only plugin downloads.
- Carries repository identity in board links so server restarts and repository switches load the correct board.
- Requires absolute repository paths in plugin tools and prevents board symlinks from escaping the repository.
- Validates saves, detects external edits, preserves edits made during saves, and serializes concurrent board mutations.
- Fixes scans of asset-heavy repositories and bounds workflow file reads.

Validated with build and type checks, diagram and concurrency smoke tests, an isolated npm tarball installation, and browser checks for editing, save conflicts, reload, and missing boards. Windows launch behavior and the native Codex file entrypoint remain unverified.
