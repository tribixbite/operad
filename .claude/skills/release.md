# Release

## Triggers
- User says `/release` or asks to publish, release, or version bump operad
- User wants to push a new version to npm

## CRITICAL: Never push tags, create releases, or publish without explicit user permission

## Pre-release Checklist

### 1. Verify clean state
```sh
git status                    # Must be clean (no uncommitted changes)
git log --oneline -10         # Review recent commits for the changelog
bun run typecheck             # Zero errors
bun run build                 # CLI bundle builds
cd dashboard && bun run build # Dashboard builds
```

### 2. Check CI
```sh
git push                      # Push any pending commits
gh run list --limit 3         # Verify CI is green
gh run watch                  # Watch if still running
```

### 3. Determine version bump
- **Patch** (0.2.X): Bug fixes, small UI tweaks, no new features
- **Minor** (0.X.0): New features, new dashboard pages/components, new API endpoints
- **Major** (X.0.0): Breaking config changes, CLI interface changes, major architecture shifts

Current version: check `package.json` → `version` field.

## Release Process

### 4. Generate changelog
Summarize commits since last tag:
```sh
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  git log --oneline $LAST_TAG..HEAD
else
  git log --oneline -20
fi
```

Group by type:
- **Features**: `feat(...)` commits
- **Fixes**: `fix(...)` commits
- **Other**: `chore`, `ci`, `docs`, etc.

### 5. Bump version (ASK USER FIRST)
```sh
# Edit package.json version field
# Also update any version references in src/tmx.ts if hardcoded
```

### 6. Commit version bump
```sh
git add package.json
git commit -m "chore: bump version to 0.X.Y"
```

### 7. Create tag and push (ASK USER FIRST)
```sh
git tag v0.X.Y
git push origin main
git push origin v0.X.Y
```

### 8. Create GitHub release (ASK USER FIRST)
```sh
gh release create v0.X.Y --title "v0.X.Y" --notes "$(cat <<'NOTES'
## What's New

### Features
- ...

### Fixes
- ...
NOTES
)"
```

This triggers the `publish.yml` workflow which:
1. Checks out the code
2. Installs deps with bun
3. Builds the CLI bundle
4. Publishes to npm with OIDC provenance

### 9. Verify publication
```sh
gh run list --limit 1                    # Watch publish workflow
gh run watch                             # Wait for completion
npm view operadic version                # Confirm new version on npm
npm view operadic dist.tarball           # Check tarball URL
```

## Rollback
If a bad version is published:
```sh
npm unpublish operadic@0.X.Y             # Within 72h only
# OR deprecate:
npm deprecate operadic@0.X.Y "Known issue — use 0.X.Z instead"
```

## Package Contents
Published files (from `package.json` `files` field):
- `dist/` — CLI bundle (tmx.js)
- `dashboard/dist/` — Built dashboard static files
- `watchdog.sh` — Session watchdog script

## npm Package Info
- Name: `operadic`
- Registry: npmjs.com
- Trusted publisher: GitHub Actions OIDC (repo: tribixbite/operad, workflow: publish.yml)
- CLI binary: `operad` (maps to `dist/tmx.js`)
