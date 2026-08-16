#!/usr/bin/env node
/**
 * Build script — bundles orchestrator into a single dist/tmx.js
 * using esbuild. Output is a self-contained Node.js CLI.
 */
const { build } = require("esbuild");
const { resolve } = require("path");

build({
  entryPoints: [resolve(__dirname, "src/tmx.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: resolve(__dirname, "dist/tmx.js"),
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  external: ["ws", "@anthropic-ai/claude-agent-sdk", "bun:sqlite", "better-sqlite3"],
  // Replace import.meta references with CJS equivalents
  define: {
    "import.meta.url": "import_meta_url",
  },
  inject: [resolve(__dirname, "src/import-meta-shim.js")],
  // Minify with keepNames so stack traces and dynamic require() paths still
  // show meaningful symbols in logs. Cuts bundle size significantly.
  minify: true,
  keepNames: true,
  sourcemap: false,
}).then(() => {
  const { chmodSync, statSync } = require("fs");
  const out = resolve(__dirname, "dist/tmx.js");

  // The bundle carries a `#!/usr/bin/env node` shebang and is this package's
  // `bin` entry, so it has to be executable. esbuild does not set the bit, and
  // npm only applies it to `bin` targets at install time — a git checkout got
  // whatever the umask allowed.
  //
  // When the bit was missing, every direct invocation failed with exit 126
  // ("found but not executable"). watchdog.sh calls the binary through the
  // symlink to decide whether to restart a dead daemon, so a rebuild could
  // silently disable the one thing that brings operad back after an OOM kill:
  // this machine's watchdog.log recorded 1,036,045 consecutive 126s.
  chmodSync(out, 0o755);

  const size = statSync(out).size;
  console.log(`Built dist/tmx.js (${(size / 1024).toFixed(1)} KB, mode 755)`);
}).catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
