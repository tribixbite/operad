/**
 * git-info.ts — Git repository status, file tree, and file content reader
 *
 * Provides git branch/status/log info and safe file browsing for session projects.
 * All file access is path-traversal-protected.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, relative, isAbsolute, extname, basename } from "node:path";

/**
 * True when `target` is `base` itself or lives underneath it. Uses
 * path.relative so it's correct on Windows (`\` separators, drive letters)
 * where the old `startsWith(base + "/")` check always failed — a resolved
 * Windows path uses `\`, so it never starts with `base + "/"` and every file
 * read was wrongly rejected as traversal. `allowSelf=false` additionally
 * rejects `target === base` (used where reading the dir itself is nonsensical).
 */
function isContained(base: string, target: string, allowSelf: boolean): boolean {
  const rel = relative(base, target);
  if (rel === "") return allowSelf;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve symlinks before a containment check.
 *
 * `isContained` is purely textual, so a symlink inside the project directory
 * pointing at ~/.ssh/id_rsa or /etc/shadow passed the check and was then
 * happily followed by readFileSync. Resolving first makes the check apply to
 * the file actually opened.
 *
 * Falls back to the lexical path when the target does not exist — the caller's
 * subsequent stat/read produces the right ENOENT rather than a confusing
 * "traversal blocked".
 */
function realPathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
import type { GitInfo, FileEntry, FileContentResponse } from "./types.js";

const MAX_FILE_SIZE = 100 * 1024; // 100KB max file content
const MAX_ENTRIES = 200; // Max directory entries

/** Language detection from file extension */
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".md": "markdown", ".html": "html", ".css": "css", ".scss": "scss",
  ".svelte": "svelte", ".astro": "astro", ".vue": "vue",
  ".sh": "bash", ".bash": "bash", ".zsh": "zsh",
  ".sql": "sql", ".graphql": "graphql",
  ".xml": "xml", ".svg": "svg",
  ".env": "dotenv", ".gitignore": "gitignore",
  ".dockerfile": "dockerfile",
};

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (LANG_MAP[ext]) return LANG_MAP[ext];
  const base = basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return "text";
}

// -- Pure parsers (exported for unit testing) ---------------------------------

/**
 * Parse the output of `git status --porcelain` into a list of dirty-file
 * status strings. Each entry is a trimmed non-empty line from the output.
 *
 * @param statusOut Raw stdout from `git status --porcelain`
 * @returns Array of status strings (e.g. [" M src/foo.ts", "?? bar.ts"])
 */
export function parseGitStatus(statusOut: string): string[] {
  if (!statusOut) return [];
  return statusOut.split("\n").map(l => l.trim()).filter(Boolean);
}

/**
 * Parse the output of `git log --oneline -N` into structured commit records.
 * Each line has the form `<hash> <message>`, where `<hash>` is the short SHA.
 *
 * @param logOut Raw stdout from `git log --oneline`
 * @returns Array of `{ hash, message }` objects; empty when logOut is empty
 */
export function parseGitLog(logOut: string): Array<{ hash: string; message: string }> {
  if (!logOut) return [];
  return logOut.split("\n").filter(Boolean).map(line => {
    const spaceIdx = line.indexOf(" ");
    return {
      hash:    spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
      message: spaceIdx > 0 ? line.slice(spaceIdx + 1) : "",
    };
  });
}

/**
 * Attempt to extract `owner/repo` from a git remote URL.
 * Handles HTTPS (`https://github.com/owner/repo.git`) and
 * SSH (`git@github.com:owner/repo.git`) formats.
 *
 * Returns `null` when the URL cannot be parsed into exactly two path segments.
 *
 * @param remoteUrl Raw URL string from `git remote get-url origin`
 */
export function parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;

  let path: string;

  if (remoteUrl.startsWith("git@")) {
    // SSH: git@github.com:owner/repo.git
    const colonIdx = remoteUrl.indexOf(":");
    if (colonIdx < 0) return null;
    path = remoteUrl.slice(colonIdx + 1);
  } else {
    // HTTPS: https://github.com/owner/repo.git
    try {
      const url = new URL(remoteUrl);
      path = url.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }

  // Strip .git suffix
  path = path.replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  return { owner: parts[0], repo: parts[1] };
}

// -- IO helpers ---------------------------------------------------------------

/** Run a git command in a project directory, return stdout */
function gitCmd(projectPath: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: projectPath,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.stdout?.trim() ?? "";
}

/** Get git repository info for a project */
export function getGitInfo(projectPath: string): GitInfo {
  // Current branch
  const branch = gitCmd(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";

  // Dirty files (porcelain format) — parsed via pure helper
  const dirty_files = parseGitStatus(gitCmd(projectPath, ["status", "--porcelain"]));

  // Recent commits (last 5, one-line format) — parsed via pure helper
  const recent_commits = parseGitLog(gitCmd(projectPath, ["log", "--oneline", "-5"]));

  return { branch, dirty_files, recent_commits };
}

/** Get file tree for a directory within a project (path-traversal protected) */
export function getFileTree(projectPath: string, subdir?: string): FileEntry[] {
  const targetDir = subdir
    ? resolve(projectPath, subdir)
    : projectPath;

  // Path traversal protection: resolved path must be the project dir or under
  // it. Real paths, so a symlinked subdirectory cannot list outside the
  // project (see getFileContent).
  if (!isContained(
    realPathOrSelf(resolve(projectPath)),
    realPathOrSelf(targetDir),
    /* allowSelf */ true,
  )) {
    throw new Error("Path traversal blocked");
  }

  const entries: FileEntry[] = [];
  try {
    const items = readdirSync(targetDir, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) break;
      // Skip hidden files/dirs (except .gitignore, etc.)
      if (item.name.startsWith(".") && item.name !== ".gitignore" && item.name !== ".env.example") continue;
      // Skip node_modules, dist, .git
      if (item.name === "node_modules" || item.name === ".git") continue;

      if (item.isDirectory()) {
        entries.push({ name: item.name, type: "directory" });
      } else if (item.isFile()) {
        try {
          const st = statSync(join(targetDir, item.name));
          entries.push({ name: item.name, type: "file", size: st.size });
        } catch {
          entries.push({ name: item.name, type: "file" });
        }
      }
    }
  } catch {
    // Directory unreadable
  }

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

/** Read file content with path traversal protection and size limit */
export function getFileContent(projectPath: string, filePath: string): FileContentResponse {
  const fullPath = resolve(projectPath, filePath);

  // Path traversal protection — must be strictly under the project dir.
  // Compare REAL paths: the check is textual, so without this a symlink
  // planted in the project pointing at ~/.ssh/id_rsa passed and was read.
  // The base is resolved too, or a project reached through a symlinked
  // parent would fail its own containment check.
  const realBase = realPathOrSelf(resolve(projectPath));
  if (!isContained(realBase, realPathOrSelf(fullPath), /* allowSelf */ false)) {
    throw new Error("Path traversal blocked");
  }

  const st = statSync(fullPath);
  // A directory here would otherwise reach readFileSync and surface as an
  // opaque EISDIR 500.
  if (!st.isFile()) {
    throw new Error("Not a file");
  }
  const truncated = st.size > MAX_FILE_SIZE;
  const readSize = truncated ? MAX_FILE_SIZE : st.size;

  let content: string;
  if (truncated) {
    const buf = Buffer.alloc(readSize);
    const fd = openSync(fullPath, "r");
    try {
      readSync(fd, buf, 0, readSize, 0);
      content = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } else {
    content = readFileSync(fullPath, "utf-8");
  }

  return {
    content,
    language: detectLanguage(filePath),
    size: st.size,
    truncated,
  };
}
