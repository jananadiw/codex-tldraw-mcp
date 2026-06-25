# npm Publishing

This project publishes `codex-tldraw-mcp` to npm.

## Current Package

- npm package: `codex-tldraw-mcp`
- package name in `package.json`: `codex-tldraw-mcp`
- release tag format: `vX.Y.Z`
- GitHub release notes: `docs/release-vX.Y.Z.md`

## Automated Publishing

Use npm Trusted Publishing so GitHub Actions can publish through OIDC without a long-lived npm token.

### One-Time npm Setup

In the npm package settings for `codex-tldraw-mcp`, add a trusted publisher:

- Provider: GitHub Actions
- Organization or user: `jananadiw`
- Repository: `codex-tldraw-mcp`
- Workflow filename: `publish-npm.yml`
- Environment: leave blank

Keep package publishing access compatible with trusted publishing. Do not choose a setting that disallows trusted publishers or automation unless you intend to publish manually.

### Release Flow

1. Update `package.json` to the next version.
2. Update `CHANGELOG.md`.
3. Add release notes under `docs/release-vX.Y.Z.md`.
4. Run local checks:

```bash
bun install
bun run build
bun run smoke
npm publish --access public --dry-run
```

5. Commit the release prep:

```bash
git add .
git commit -m "chore: prepare vX.Y.Z release"
git push origin main
```

6. Create and push the release tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

7. Create a GitHub release from the matching release notes:

```bash
gh release create vX.Y.Z \
  --repo jananadiw/codex-tldraw-mcp \
  --title "codex-tldraw-mcp vX.Y.Z" \
  --notes-file docs/release-vX.Y.Z.md
```

Publishing the GitHub release triggers `.github/workflows/publish-npm.yml`, which builds, smoke-tests, and publishes to npm.

8. Verify npm:

```bash
npm view codex-tldraw-mcp version dist-tags --json
npm view codex-tldraw-mcp versions --json
```

## Manual Fallback

If Trusted Publishing is not configured yet, publish manually from a clean local checkout:

```bash
npm login
npm publish --access public
```

If npm asks for security-key authentication, open the URL printed by the CLI and approve the prompt. If the account uses authenticator-app OTP instead, publish with:

```bash
npm publish --access public --otp=<code>
```

Then verify:

```bash
npm view codex-tldraw-mcp version dist-tags --json
```

## MCP Registry

MCP Registry publishing is intentionally separate from npm publishing and is currently skipped for this project.
