# Security Policy

## Local Filesystem Access

`codex-tldraw-mcp` is a local stdio MCP server. It reads source files from the configured `repoPath` and writes generated `.tldr` files to `repoPath/boards`.

By default, the server can access paths that the local user account can access. To restrict access, set `TLDRAW_MCP_ALLOWED_ROOTS` to a path-delimited allowlist. When set, `repoPath` must resolve inside one of the allowed roots.

## Reporting Issues

Do not open public issues for sensitive security reports. Contact the maintainer privately, or use GitHub private vulnerability reporting if it is enabled for the repository.

Include:

- Affected version or commit.
- Steps to reproduce.
- Impact and affected files or paths.
- Any suggested fix, if available.
