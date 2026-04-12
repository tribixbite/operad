# operad Build & Deploy

## Triggers
- User asks to build, release, publish, or deploy operad
- User asks to update the landing page or dashboard

## Build CLI

```sh
cd ~/git/operad
bun install
bun run build        # → dist/tmx.js (~113KB CJS)
bun run typecheck    # zero errors required
```

**Critical**: `bun run build` runs `node build.cjs` (NOT `bun build.cjs`). Bun rejects the android-arm64 esbuild binary.

## Build Dashboard

```sh
cd ~/git/operad/dashboard
bun install
node scripts/fix-android-binaries.mjs  # Android only
bun run build        # → dashboard/dist/
```

## Build Landing Page

```sh
cd ~/git/operad/site
bun install
node scripts/fix-android-binaries.mjs  # Android only
bun run build        # → site/dist/
```

Site deploys automatically to operad.stream via GitHub Pages on push to main (paths: site/**).

## Hot-swap Running Daemon

```sh
tmx upgrade          # Rebuilds bundle, stops daemon, watchdog restarts
# OR manually:
bun run build && tmx shutdown  # Watchdog auto-restarts with new bundle
```

## Publish to npm

Option A — GitHub Release (preferred, uses trusted publishing):
```sh
# Bump version in package.json
git tag v0.X.0
git push origin v0.X.0
# Create release on GitHub → publish.yml triggers with OIDC provenance
```

Option B — Local publish:
```sh
bun run build
npm publish --access public --otp=<CODE>
# Note: --provenance only works in GitHub Actions
```

## CI Matrix
- ubuntu-latest + macos-latest
- Steps: install → typecheck → build → verify bundle → smoke test (--version)

## Verification Checklist
1. `bun run typecheck` — zero errors
2. `bun run build` — dist/tmx.js exists
3. `node dist/tmx.js --version` — prints `operad v0.X.0`
4. `tmx boot` — sessions start, dashboard loads at :18970
5. CI green on both ubuntu and macos
