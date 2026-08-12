/**
 * log.ts — Structured logging (JSONL file + pretty stderr)
 *
 * Writes structured JSON lines to a rotating log file and
 * human-readable colored output to stderr for interactive use.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import type { LogEntry } from "./types.js";

/** Maximum log file size before rotation (5 MB) */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** Number of rotated log files to keep */
const MAX_ROTATED = 3;

/** ANSI color codes for log levels */
const LEVEL_COLORS: Record<string, string> = {
  debug: "\x1b[90m",  // gray
  info:  "\x1b[36m",  // cyan
  warn:  "\x1b[33m",  // yellow
  error: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export class Logger {
  private logFile: string;
  private logDir: string;
  private verbose: boolean;
  /** Whether this process has already tightened the log file's mode. */
  private logModeChecked = false;

  constructor(logDir: string, verbose = false) {
    this.logDir = logDir;
    this.logFile = `${logDir}/tmx.jsonl`;
    this.verbose = verbose;

    // Ensure log directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /** Log at debug level */
  debug(msg: string, extra?: Record<string, unknown>): void {
    this.log("debug", msg, extra);
  }

  /** Log at info level */
  info(msg: string, extra?: Record<string, unknown>): void {
    this.log("info", msg, extra);
  }

  /** Log at warn level */
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.log("warn", msg, extra);
  }

  /** Log at error level */
  error(msg: string, extra?: Record<string, unknown>): void {
    this.log("error", msg, extra);
  }

  /** Set verbose mode (show debug messages on stderr) */
  setVerbose(v: boolean): void {
    this.verbose = v;
  }

  /** Write a structured log entry */
  private log(level: LogEntry["level"], msg: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...extra,
    };

    // Write JSONL to file
    this.writeToFile(entry);

    // Write pretty output to stderr (skip debug unless verbose)
    if (level !== "debug" || this.verbose) {
      this.writeToStderr(entry);
    }
  }

  /**
   * Tighten the log file's permissions once per process.
   *
   * appendFileSync's `mode` only takes effect when it creates the file, so a
   * log written by an earlier version — or created under a looser umask —
   * stays world-readable forever without this.
   */
  private ensureLogMode(): void {
    if (this.logModeChecked) return;
    this.logModeChecked = true;
    try {
      chmodSync(this.logFile, 0o600);
    } catch {
      // Read-only FS or foreign owner — the log content still got written.
    }
  }

  /** Append a JSONL line to the log file, rotating if needed */
  private writeToFile(entry: LogEntry): void {
    try {
      this.rotateIfNeeded();
      // 0600: the log carries session paths, prompts and command lines, and
      // appendFileSync with no mode creates it world-readable under a desktop
      // umask of 022. The mode argument only applies on CREATE, so an
      // already-existing log keeps whatever mode it has — tightened once, in
      // ensureLogMode(), rather than on every write.
      appendFileSync(this.logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
      this.ensureLogMode();
    } catch {
      // If we can't write logs, print to stderr as fallback
      process.stderr.write(`[log-write-error] ${JSON.stringify(entry)}\n`);
    }
  }

  /** Print a human-readable log line to stderr */
  private writeToStderr(entry: LogEntry): void {
    const color = LEVEL_COLORS[entry.level] ?? "";
    const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm
    const levelTag = entry.level.toUpperCase().padEnd(5);
    const sessionTag = entry.session ? ` ${DIM}[${entry.session}]${RESET}` : "";

    // Collect extra fields (skip ts, level, msg, session)
    const extras: string[] = [];
    for (const [k, v] of Object.entries(entry)) {
      if (k === "ts" || k === "level" || k === "msg" || k === "session") continue;
      extras.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    const extraStr = extras.length > 0 ? ` ${DIM}${extras.join(" ")}${RESET}` : "";

    process.stderr.write(
      `${DIM}${time}${RESET} ${color}${levelTag}${RESET}${sessionTag} ${entry.msg}${extraStr}\n`
    );
  }

  /** Rotate log file if it exceeds MAX_LOG_SIZE */
  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFile)) return;
      const { size } = statSync(this.logFile);
      if (size < MAX_LOG_SIZE) return;

      // Shift existing rotated files
      for (let i = MAX_ROTATED - 1; i >= 1; i--) {
        const from = `${this.logFile}.${i}`;
        const to = `${this.logFile}.${i + 1}`;
        if (existsSync(from)) {
          renameSync(from, to);
        }
      }

      // Rotate current file to .1
      renameSync(this.logFile, `${this.logFile}.1`);
      // The next append creates a brand-new file, so its mode must be
      // re-asserted rather than assumed from the pre-rotation check.
      this.logModeChecked = false;
    } catch {
      // Rotation failure is non-fatal
    }
  }

  /** Read the last N lines from the log file (for `operad logs`) */
  readTail(lines: number, sessionFilter?: string): LogEntry[] {
    try {
      if (!existsSync(this.logFile)) return [];
      const content = readFileSync(this.logFile, "utf-8");
      const allLines = content.trim().split("\n").filter(Boolean);

      let entries: LogEntry[] = allLines.map((line: string) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      }).filter((e: LogEntry | null): e is LogEntry => e !== null);

      // Filter by session name if specified
      if (sessionFilter) {
        entries = entries.filter((e) => e.session === sessionFilter);
      }

      return entries.slice(-lines);
    } catch {
      return [];
    }
  }
}
