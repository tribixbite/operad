#!/usr/bin/env node
/**
 * verify-package.mjs — assert the publishable tarball is complete.
 *
 * Guards against the class of bug where `package.json#files` lists an artifact
 * that no build step actually produced, so `npm publish` silently ships a
 * partial package. That is exactly how operad <= 0.4.7 reached npm with no
 * dashboard: `dashboard/dist/` was in `files`, but the publish workflow only
 * ran the esbuild CLI bundle, so every installed copy reported
 * "Dashboard dist not bundled" and served no web UI.
 *
 * Runs `npm pack --dry-run --json` (which resolves `files`, .npmignore and
 * npm's built-in rules exactly as a real publish would) and asserts every
 * required entry is present and non-empty.
 *
 * Usage: node scripts/verify-package.mjs
 * Exit 0 = tarball complete, exit 1 = missing/empty entries (with details).
 */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * Entries that MUST exist in the published tarball.
 * `prefix: true` matches any file starting with the given path, for
 * content-hashed asset directories whose exact filenames vary per build.
 */
const REQUIRED = [
  { path: "dist/tmx.js", why: "CLI entry point (package.json#bin)" },
  { path: "dashboard/dist/index.html", why: "dashboard SPA shell" },
  { path: "dashboard/dist/_app/", why: "dashboard JS/CSS assets", prefix: true },
  { path: "README.md", why: "shown on the npmjs package page" },
  { path: "LICENSE", why: "license text" },
  { path: "CHANGELOG.md", why: "release notes" },
];

/**
 * @returns {{path: string, size: number}[]} files npm would include
 *
 * Runs through a shell deliberately. On Windows npm is the `npm.cmd` shim, and
 * since the CVE-2024-27980 fix Node refuses to spawn `.cmd`/`.bat` without a
 * shell — `execFileSync("npm", …)` gives ENOENT and `execFileSync("npm.cmd", …)`
 * gives EINVAL. The command line below is a fixed literal with no interpolated
 * input, so there is nothing for a shell to inject.
 */
function packFileList() {
  // --json puts the manifest on stdout; npm notices go to stderr.
  const raw = execSync("npm pack --dry-run --json", {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error("Unexpected `npm pack --json` output shape — no files[]");
  }
  // Normalise separators so the REQUIRED table (written with "/") matches on
  // Windows too, regardless of what npm emits there.
  return entry.files.map((f) => ({ ...f, path: String(f.path).replace(/\\/g, "/") }));
}

const files = packFileList();
const byPath = new Map(files.map((f) => [f.path, f]));
const failures = [];

for (const req of REQUIRED) {
  if (req.prefix) {
    const matches = files.filter(
      (f) => f.path.startsWith(req.path) && f.size > 0,
    );
    if (matches.length === 0) {
      failures.push(`missing: ${req.path}* (${req.why})`);
    }
    continue;
  }
  const found = byPath.get(req.path);
  if (!found) {
    failures.push(`missing: ${req.path} (${req.why})`);
  } else if (found.size === 0) {
    failures.push(`empty: ${req.path} (${req.why})`);
  }
}

const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

if (failures.length > 0) {
  console.error("\nPackage verification FAILED:\n");
  for (const f of failures) console.error(`  x ${f}`);
  console.error(
    `\n${files.length} files / ${(totalBytes / 1024).toFixed(1)} KB would be published.`,
  );
  console.error(
    "\nThe dashboard is built separately from the CLI bundle. Run:\n" +
      "  bun run build\n" +
      "  cd dashboard && bun install && bun run build\n",
  );
  process.exit(1);
}

// The CLI bundle carries a `#!/usr/bin/env node` shebang and is the package's
// `bin` entry, so it must be executable in the working tree. esbuild does not
// set the bit; when it was missing, every direct invocation failed with exit
// 126 ("found but not executable"), which silently disabled watchdog.sh — the
// one thing that restarts the daemon after an OOM kill. It logged 1,036,045
// consecutive failures before anyone noticed. build.cjs chmods the output now;
// this keeps it that way.
//
// Skipped on Windows, where the POSIX execute bit is not meaningful.
if (process.platform !== "win32") {
  const binPath = new URL("../dist/tmx.js", import.meta.url);
  const mode = statSync(binPath).mode;
  if ((mode & 0o111) === 0) {
    console.error(
      `dist/tmx.js is not executable (mode ${(mode & 0o777).toString(8)}).\n` +
        `  It is package.json#bin and has a shebang — run 'bun run build' to rebuild,\n` +
        `  or 'chmod +x dist/tmx.js'. A non-executable bundle exits 126 and breaks\n` +
        `  watchdog.sh's ability to restart a dead daemon.`,
    );
    process.exit(1);
  }
}

console.log(
  `Package verification OK — ${files.length} files, ` +
    `${(totalBytes / 1024).toFixed(1)} KB.`,
);
for (const req of REQUIRED) {
  const label = req.prefix
    ? `${files.filter((f) => f.path.startsWith(req.path)).length} file(s)`
    : `${byPath.get(req.path).size} bytes`;
  console.log(`  ok ${req.path} — ${label}`);
}
