/**
 * scripts-routes.ts — Script listing/running/saving REST API route handlers.
 *
 * Handles GET /api/scripts/:session, POST /api/run-script/:session,
 * and POST /api/save-script/:session.
 *
 * Extracted from RestHandler (rest-handler.ts) as part of domain split.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorContext } from "../orchestrator-context.js";
import { runScriptInTab } from "../session.js";

/** Portable bash shebang — matches the one in daemon.ts */
const BASH_SHEBANG = process.env.PREFIX
  ? `#!${process.env.PREFIX}/bin/bash`
  : `#!/usr/bin/env bash`;

/**
 * ScriptsRoutes — handles script listing, execution, and persistence for
 * a session's project directory.
 */
export class ScriptsRoutes {
  constructor(private readonly ctx: OrchestratorContext) {}

  /** List available scripts for a session project */
  cmdListScripts(sessionName: string): { status: number; data: unknown } {
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    interface ScriptEntryOut {
      name: string;
      path: string;
      source: "root" | "scripts" | "package.json" | "saved";
      command?: string;
    }
    const scripts: ScriptEntryOut[] = [];

    try {
      const entries = readdirSync(sessionPath);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          const full = join(sessionPath, f);
          try {
            if (statSync(full).isFile()) {
              scripts.push({ name: f, path: full, source: "root" });
            }
          } catch { /* stat failed — skip */ }
        }
      }
    } catch { /* dir unreadable — skip */ }

    try {
      const scriptsDir = join(sessionPath, "scripts");
      const entries = readdirSync(scriptsDir);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          scripts.push({ name: f, path: join(scriptsDir, f), source: "scripts" });
        }
      }
    } catch { /* no scripts/ dir — skip */ }

    try {
      const pkgPath = join(sessionPath, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      if (pkg.scripts) {
        for (const [scriptName, cmd] of Object.entries(pkg.scripts)) {
          scripts.push({ name: scriptName, path: "", source: "package.json", command: cmd });
        }
      }
    } catch { /* no package.json or parse error — skip */ }

    try {
      const savedDir = join(sessionPath, ".tmx-scripts");
      const entries = readdirSync(savedDir);
      for (const f of entries) {
        if (f.endsWith(".sh")) {
          scripts.push({ name: f, path: join(savedDir, f), source: "saved" });
        }
      }
    } catch { /* no saved scripts — skip */ }

    return { status: 200, data: { scripts } };
  }

  /** Run a script or ad-hoc command in a session's Termux tab */
  cmdRunScript(
    sessionName: string,
    opts: { command?: string; script?: string; source?: string },
  ): { status: number; data: unknown } {
    const resolved = this.ctx.resolveName(sessionName);
    if (!resolved) return { status: 400, data: { error: `Unknown session: ${sessionName}` } };
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    const prefix = process.env.PREFIX ?? "/usr";

    if (opts.command) {
      const tempScript = join(prefix, "tmp", `tmx-cmd-${resolved}.sh`);
      writeFileSync(tempScript, `${BASH_SHEBANG}\n${opts.command}\n`, { mode: 0o755 });
      if (runScriptInTab(tempScript, sessionPath, resolved, this.ctx.log)) {
        return { status: 200, data: { ok: true } };
      }
      return { status: 500, data: { error: "Failed to launch command" } };
    }

    if (opts.script && opts.source) {
      let scriptPath: string;
      switch (opts.source) {
        case "root":
          scriptPath = join(sessionPath, opts.script);
          break;
        case "scripts":
          scriptPath = join(sessionPath, "scripts", opts.script);
          break;
        case "package.json": {
          const tempScript = join(prefix, "tmp", `tmx-npm-${resolved}.sh`);
          writeFileSync(
            tempScript,
            `${BASH_SHEBANG}\ncd "${sessionPath}" || exit 1\nbun run ${opts.script}\n`,
            { mode: 0o755 },
          );
          if (runScriptInTab(tempScript, sessionPath, resolved, this.ctx.log)) {
            return { status: 200, data: { ok: true } };
          }
          return { status: 500, data: { error: "Failed to launch npm script" } };
        }
        case "saved":
          scriptPath = join(sessionPath, ".tmx-scripts", opts.script);
          break;
        default:
          return { status: 400, data: { error: `Unknown script source: ${opts.source}` } };
      }

      if (!existsSync(scriptPath)) {
        return { status: 404, data: { error: `Script not found: ${scriptPath}` } };
      }
      if (runScriptInTab(scriptPath, sessionPath, resolved, this.ctx.log)) {
        return { status: 200, data: { ok: true } };
      }
      return { status: 500, data: { error: `Failed to launch script: ${opts.script}` } };
    }

    return { status: 400, data: { error: "Provide either 'command' or 'script' + 'source'" } };
  }

  /** Save an ad-hoc command as a reusable .sh script in .tmx-scripts/ */
  cmdSaveScript(
    sessionName: string,
    opts: { name: string; command: string },
  ): { status: number; data: unknown } {
    const sessionPath = this.ctx.resolveSessionPath(sessionName);
    if (!sessionPath) return { status: 400, data: { error: `Session '${sessionName}' has no path` } };

    if (!/^[a-zA-Z0-9_-]+$/.test(opts.name)) {
      return { status: 400, data: { error: "Script name must be alphanumeric (a-z, 0-9, -, _)" } };
    }
    if (!opts.command?.trim()) {
      return { status: 400, data: { error: "Command cannot be empty" } };
    }

    const savedDir = join(sessionPath, ".tmx-scripts");
    mkdirSync(savedDir, { recursive: true });
    const fileName = opts.name.endsWith(".sh") ? opts.name : `${opts.name}.sh`;
    const filePath = join(savedDir, fileName);

    writeFileSync(filePath, `${BASH_SHEBANG}\n${opts.command}\n`, { mode: 0o755 });
    this.ctx.log.info(`Saved script '${fileName}' for session '${sessionName}'`);
    return { status: 200, data: { name: fileName, path: filePath, source: "saved" as const } };
  }
}
