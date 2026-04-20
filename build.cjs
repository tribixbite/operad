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
  const { statSync } = require("fs");
  const size = statSync(resolve(__dirname, "dist/tmx.js")).size;
  console.log(`Built dist/tmx.js (${(size / 1024).toFixed(1)} KB)`);
}).catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
