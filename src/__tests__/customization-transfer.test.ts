/**
 * customization-transfer.test.ts — export/import bundle round trip.
 *
 * Covers the migration path this module exists for: build a bundle from one
 * "machine" (a temp HOME), apply it to a second empty HOME, and assert the
 * files actually arrive with their content intact — including directory-form
 * and symlinked skills, which the old path-only export could not carry.
 *
 * Also pins the path-traversal defences: bundles are untrusted input.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_KIND,
  BUNDLE_FORMAT_VERSION,
  buildBundle,
  collectDocuments,
  importBundle,
  isDocumentFile,
  isSafeRelPath,
  readMarketplaces,
  validateBundle,
  type CustomizationBundle,
} from "../routes/customization-transfer.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** $TMPDIR-rooted temp dir (Termux-safe — /tmp is not writable there). */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "operad-transfer-"));
}

/** Write a file, creating parent dirs. */
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** Minimal well-formed bundle for import-side tests. */
function emptyBundle(overrides: Partial<CustomizationBundle> = {}): CustomizationBundle {
  return {
    kind: BUNDLE_KIND,
    format_version: BUNDLE_FORMAT_VERSION,
    meta: {
      exported_at: "2026-01-01T00:00:00.000Z",
      exported_from: "test-host",
      operad_version: "0.0.0-test",
    },
    documents: [],
    marketplaces: [],
    plugins: [],
    mcp_servers: [],
    ...overrides,
  };
}

// ── pure path guards ───────────────────────────────────────────────────────

describe("isSafeRelPath", () => {
  test("accepts ordinary flat and nested document paths", () => {
    expect(isSafeRelPath("foo.md")).toBe(true);
    expect(isSafeRelPath("brainstorming/SKILL.md")).toBe(true);
    expect(isSafeRelPath("a/b/c.md")).toBe(true);
  });

  test("rejects parent traversal", () => {
    expect(isSafeRelPath("../evil.md")).toBe(false);
    expect(isSafeRelPath("a/../../evil.md")).toBe(false);
    expect(isSafeRelPath("..")).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("\\windows\\system32")).toBe(false);
  });

  test("rejects Windows drive-qualified paths", () => {
    expect(isSafeRelPath("C:/Windows/evil.md")).toBe(false);
  });

  test("rejects backslash traversal (Windows separator)", () => {
    expect(isSafeRelPath("a\\..\\..\\evil.md")).toBe(false);
  });

  test("rejects empty, over-long, and control-character paths", () => {
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("a".repeat(600))).toBe(false);
    expect(isSafeRelPath(`a${String.fromCharCode(0)}.md`)).toBe(false);
  });

  test("rejects components with trailing dot or space (Windows collision)", () => {
    expect(isSafeRelPath("foo./bar.md")).toBe(false);
    expect(isSafeRelPath("foo /bar.md")).toBe(false);
  });
});

describe("isDocumentFile", () => {
  test("accepts markdown and text", () => {
    expect(isDocumentFile("a.md")).toBe(true);
    expect(isDocumentFile("a.markdown")).toBe(true);
    expect(isDocumentFile("a.txt")).toBe(true);
    expect(isDocumentFile("SKILL.MD")).toBe(true);
  });

  test("rejects dotfiles and other extensions", () => {
    expect(isDocumentFile(".credentials.json")).toBe(false);
    expect(isDocumentFile("script.sh")).toBe(false);
    expect(isDocumentFile("data.json")).toBe(false);
  });
});

// ── validation ─────────────────────────────────────────────────────────────

describe("validateBundle", () => {
  test("accepts a well-formed bundle", () => {
    expect(validateBundle(emptyBundle())).toBeNull();
  });

  test("rejects non-objects", () => {
    expect(validateBundle(null)).toBeTruthy();
    expect(validateBundle("nope")).toBeTruthy();
  });

  test("rejects a foreign kind", () => {
    expect(validateBundle({ ...emptyBundle(), kind: "something-else" })).toContain(
      "unrecognised bundle kind",
    );
  });

  test("rejects a future format_version", () => {
    const r = validateBundle({
      ...emptyBundle(),
      format_version: BUNDLE_FORMAT_VERSION + 1,
    });
    expect(r).toContain("newer than supported");
  });

  test("rejects a missing format_version", () => {
    const b = emptyBundle() as unknown as Record<string, unknown>;
    delete b.format_version;
    expect(validateBundle(b)).toBeTruthy();
  });

  test("rejects a non-array documents field", () => {
    expect(validateBundle({ ...emptyBundle(), documents: "no" })).toContain(
      "must be an array",
    );
  });
});

// ── collection scanning ────────────────────────────────────────────────────

describe("collectDocuments — both skill layouts", () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("collects flat .md files", () => {
    put(join(dir, "alpha.md"), "# alpha");
    const docs = collectDocuments(dir, "skills", "user");
    expect(docs).toHaveLength(1);
    expect(docs[0].rel_path).toBe("alpha.md");
    expect(docs[0].content).toBe("# alpha");
  });

  test("collects directory-form skills (<name>/SKILL.md)", () => {
    put(join(dir, "brainstorming", "SKILL.md"), "# brainstorming");
    const docs = collectDocuments(dir, "skills", "user");
    expect(docs).toHaveLength(1);
    expect(docs[0].rel_path).toBe("brainstorming/SKILL.md");
  });

  test("collects reference files alongside SKILL.md", () => {
    put(join(dir, "s", "SKILL.md"), "main");
    put(join(dir, "s", "references", "extra.md"), "extra");
    const rels = collectDocuments(dir, "skills", "user").map((d) => d.rel_path).sort();
    expect(rels).toEqual(["s/SKILL.md", "s/references/extra.md"]);
  });

  test("follows symlinked skill directories", () => {
    const real = join(dir, "real-lib", "shared-skill");
    put(join(real, "SKILL.md"), "# shared");
    const skillsRoot = join(dir, "skills");
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(real, join(skillsRoot, "shared-skill"));

    const docs = collectDocuments(skillsRoot, "skills", "user");
    expect(docs).toHaveLength(1);
    expect(docs[0].rel_path).toBe("shared-skill/SKILL.md");
    expect(docs[0].content).toBe("# shared");
  });

  test("skips dotfiles and non-document extensions", () => {
    put(join(dir, "keep.md"), "yes");
    put(join(dir, ".hidden.md"), "no");
    put(join(dir, "script.sh"), "no");
    const rels = collectDocuments(dir, "skills", "user").map((d) => d.rel_path);
    expect(rels).toEqual(["keep.md"]);
  });

  test("returns empty for a missing root", () => {
    expect(collectDocuments(join(dir, "nope"), "skills", "user")).toEqual([]);
  });

  test("tags collection and scope on every document", () => {
    put(join(dir, "a.md"), "x");
    const [doc] = collectDocuments(dir, "commands", "project");
    expect(doc.collection).toBe("commands");
    expect(doc.scope).toBe("project");
  });
});

describe("readMarketplaces", () => {
  let home: string;
  beforeEach(() => { home = makeTempDir(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test("reads name + source pairs", () => {
    put(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        "claude-plugins-official": {
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          installLocation: "/machine/a/path",
        },
      }),
    );
    const mps = readMarketplaces(home);
    expect(mps).toHaveLength(1);
    expect(mps[0].name).toBe("claude-plugins-official");
    expect(mps[0].source).toEqual({ source: "github", repo: "anthropics/claude-plugins-official" });
  });

  test("returns empty when the file is absent or malformed", () => {
    expect(readMarketplaces(home)).toEqual([]);
    put(join(home, ".claude", "plugins", "known_marketplaces.json"), "{not json");
    expect(readMarketplaces(home)).toEqual([]);
  });
});

// ── round trip ─────────────────────────────────────────────────────────────

describe("export → import round trip", () => {
  let src: string;
  let dst: string;

  beforeEach(() => {
    src = makeTempDir();
    dst = makeTempDir();
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  });

  test("skills, commands and agents transfer with content intact", () => {
    put(join(src, ".claude", "skills", "flat.md"), "# flat skill");
    put(join(src, ".claude", "skills", "dirform", "SKILL.md"), "# dir skill");
    put(join(src, ".claude", "commands", "deploy.md"), "# deploy");
    put(join(src, ".claude", "agents", "reviewer.md"), "# reviewer");

    const bundle = buildBundle({ home: src });
    const report = importBundle(bundle, { home: dst });

    expect(report.written.length).toBe(4);
    expect(readFileSync(join(dst, ".claude", "skills", "flat.md"), "utf-8")).toBe("# flat skill");
    expect(readFileSync(join(dst, ".claude", "skills", "dirform", "SKILL.md"), "utf-8")).toBe("# dir skill");
    expect(readFileSync(join(dst, ".claude", "commands", "deploy.md"), "utf-8")).toBe("# deploy");
    expect(readFileSync(join(dst, ".claude", "agents", "reviewer.md"), "utf-8")).toBe("# reviewer");
  });

  test("bundle carries the expected envelope", () => {
    const bundle = buildBundle({ home: src, operadVersion: "9.9.9" });
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.format_version).toBe(BUNDLE_FORMAT_VERSION);
    expect(bundle.meta.operad_version).toBe("9.9.9");
    expect(typeof bundle.meta.exported_at).toBe("string");
  });

  test("existing files are skipped unless overwrite is set", () => {
    put(join(src, ".claude", "skills", "a.md"), "new");
    put(join(dst, ".claude", "skills", "a.md"), "old");

    const bundle = buildBundle({ home: src });

    const skipReport = importBundle(bundle, { home: dst });
    expect(skipReport.written).toHaveLength(0);
    expect(skipReport.skipped[0].reason).toBe("already exists");
    expect(readFileSync(join(dst, ".claude", "skills", "a.md"), "utf-8")).toBe("old");

    const overwriteReport = importBundle(bundle, { home: dst, overwrite: true });
    expect(overwriteReport.written).toHaveLength(1);
    expect(readFileSync(join(dst, ".claude", "skills", "a.md"), "utf-8")).toBe("new");
  });

  test("dry run reports writes without touching disk", () => {
    put(join(src, ".claude", "skills", "a.md"), "x");
    const bundle = buildBundle({ home: src });
    const report = importBundle(bundle, { home: dst, dryRun: true });
    expect(report.written).toHaveLength(1);
    expect(existsSync(join(dst, ".claude", "skills", "a.md"))).toBe(false);
  });

  test("collection filter restricts what is written", () => {
    put(join(src, ".claude", "skills", "a.md"), "skill");
    put(join(src, ".claude", "commands", "b.md"), "command");
    const bundle = buildBundle({ home: src });
    const report = importBundle(bundle, { home: dst, collections: ["skills"] });
    expect(existsSync(join(dst, ".claude", "skills", "a.md"))).toBe(true);
    expect(existsSync(join(dst, ".claude", "commands", "b.md"))).toBe(false);
    expect(report.skipped.some((s) => s.reason.includes("not selected"))).toBe(true);
  });
});

// ── import hardening ───────────────────────────────────────────────────────

describe("importBundle — hostile input", () => {
  let dst: string;
  beforeEach(() => { dst = makeTempDir(); });
  afterEach(() => { rmSync(dst, { recursive: true, force: true }); });

  test("traversal in rel_path is refused, not written", () => {
    const bundle = emptyBundle({
      documents: [
        { collection: "skills", scope: "user", rel_path: "../../pwned.md", content: "x" },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.written).toHaveLength(0);
    expect(report.skipped[0].reason).toContain("unsafe path");
    expect(existsSync(join(dst, "pwned.md"))).toBe(false);
  });

  test("absolute rel_path is refused", () => {
    const bundle = emptyBundle({
      documents: [
        { collection: "skills", scope: "user", rel_path: "/etc/pwned.md", content: "x" },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.written).toHaveLength(0);
    expect(report.skipped[0].reason).toContain("unsafe path");
  });

  test("unknown collection is refused", () => {
    const bundle = emptyBundle({
      documents: [
        { collection: "etc" as never, scope: "user", rel_path: "x.md", content: "x" },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.written).toHaveLength(0);
    expect(report.skipped[0].reason).toContain("unknown collection");
  });

  test("document without string content is refused", () => {
    const bundle = emptyBundle({
      documents: [
        { collection: "skills", scope: "user", rel_path: "x.md", content: undefined as never },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.skipped[0].reason).toBe("missing content");
  });

  test("project-scoped docs are skipped when no target project is given", () => {
    const bundle = emptyBundle({
      documents: [
        { collection: "skills", scope: "project", rel_path: "x.md", content: "x" },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.written).toHaveLength(0);
    expect(report.skipped[0].reason).toContain("no target project");
  });

  test("project-scoped docs land under the given project", () => {
    const proj = makeTempDir();
    try {
      const bundle = emptyBundle({
        documents: [
          { collection: "skills", scope: "project", rel_path: "x.md", content: "p" },
        ],
      });
      importBundle(bundle, { home: dst, projectPath: proj });
      expect(readFileSync(join(proj, ".claude", "skills", "x.md"), "utf-8")).toBe("p");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ── plugins + MCP ──────────────────────────────────────────────────────────

describe("importBundle — marketplaces, plugins and MCP", () => {
  let dst: string;
  beforeEach(() => { dst = makeTempDir(); });
  afterEach(() => { rmSync(dst, { recursive: true, force: true }); });

  test("marketplaces are registered with a LOCAL installLocation", () => {
    const bundle = emptyBundle({
      marketplaces: [
        { name: "official", source: { source: "github", repo: "anthropics/x" } },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.marketplaces_added).toEqual(["official"]);

    const km = JSON.parse(
      readFileSync(join(dst, ".claude", "plugins", "known_marketplaces.json"), "utf-8"),
    ) as Record<string, { source: unknown; installLocation: string }>;
    expect(km.official.source).toEqual({ source: "github", repo: "anthropics/x" });
    // The source machine's absolute path must NOT be carried over.
    expect(km.official.installLocation).toBe(
      join(dst, ".claude", "plugins", "marketplaces", "official"),
    );
  });

  test("enabled plugins are written to settings.json enabledPlugins", () => {
    const bundle = emptyBundle({
      plugins: [
        { id: "sp@official", name: "sp", marketplace: "official", version: "1", enabled: true, scope: "user" },
        { id: "off@official", name: "off", marketplace: "official", version: "1", enabled: false, scope: "user" },
      ],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.plugins_enabled).toEqual(["sp@official"]);

    const settings = JSON.parse(
      readFileSync(join(dst, ".claude", "settings.json"), "utf-8"),
    ) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins["sp@official"]).toBe(true);
    expect(settings.enabledPlugins["off@official"]).toBeUndefined();
  });

  test("existing settings.json keys are preserved when merging", () => {
    put(join(dst, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: { a: 1 } }));
    const bundle = emptyBundle({
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    importBundle(bundle, { home: dst });
    const settings = JSON.parse(
      readFileSync(join(dst, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({ a: 1 });
    expect(settings.enabledPlugins).toEqual({ "p@m": true });
  });

  test("plugin import warns that operad does not install them", () => {
    const bundle = emptyBundle({
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.warnings.join(" ")).toContain("Claude Code installs them");
  });

  test("MCP servers are not imported unless explicitly requested", () => {
    const bundle = emptyBundle({
      mcp_servers: [{ name: "s", scope: "user", command: "node", args: [], disabled: false }],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.mcp_servers_added).toHaveLength(0);
    expect(existsSync(join(dst, ".claude.json"))).toBe(false);
    expect(report.warnings.join(" ")).toContain("were not imported");
  });

  test("redacted MCP env values are dropped, not written as '***'", () => {
    const bundle = emptyBundle({
      mcp_servers: [
        {
          name: "s",
          scope: "user",
          command: "node",
          args: ["x.js"],
          env: { API_KEY: "***", PORT: "8080" },
          disabled: false,
        },
      ],
    });
    const report = importBundle(bundle, { home: dst, includeMcp: true });
    expect(report.mcp_servers_added).toEqual(["s"]);

    const cj = JSON.parse(readFileSync(join(dst, ".claude.json"), "utf-8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(cj.mcpServers.s.env).toEqual({ PORT: "8080" });
    expect(report.warnings.join(" ")).toContain("redacted env value");
  });

  test("include_plugins:false leaves marketplaces and settings untouched", () => {
    const bundle = emptyBundle({
      marketplaces: [{ name: "m", source: {} }],
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    const report = importBundle(bundle, { home: dst, includePlugins: false });
    expect(report.marketplaces_added).toHaveLength(0);
    expect(report.plugins_enabled).toHaveLength(0);
    expect(existsSync(join(dst, ".claude", "settings.json"))).toBe(false);
  });
});

describe("mergeJsonFile robustness (via importBundle)", () => {
  let dst: string;
  beforeEach(() => { dst = makeTempDir(); });
  afterEach(() => { rmSync(dst, { recursive: true, force: true }); });

  test("an array-shaped settings.json does not silently swallow the merge", () => {
    // typeof [] === "object", but assigning a key to an array is dropped by
    // JSON.stringify — the write would appear to succeed and change nothing.
    put(join(dst, ".claude", "settings.json"), "[1,2,3]");
    const bundle = emptyBundle({
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    importBundle(bundle, { home: dst });
    const settings = JSON.parse(
      readFileSync(join(dst, ".claude", "settings.json"), "utf-8"),
    ) as { enabledPlugins?: Record<string, boolean> };
    expect(Array.isArray(settings)).toBe(false);
    expect(settings.enabledPlugins).toEqual({ "p@m": true });
  });

  test("a malformed settings.json is replaced rather than aborting the import", () => {
    put(join(dst, ".claude", "settings.json"), "{ not json");
    const bundle = emptyBundle({
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    const report = importBundle(bundle, { home: dst });
    expect(report.plugins_enabled).toEqual(["p@m"]);
  });

  test("a string-shaped JSON file is not treated as an object", () => {
    put(join(dst, ".claude", "settings.json"), '"hello"');
    const bundle = emptyBundle({
      plugins: [{ id: "p@m", name: "p", marketplace: "m", version: "1", enabled: true, scope: "user" }],
    });
    importBundle(bundle, { home: dst });
    const settings = JSON.parse(
      readFileSync(join(dst, ".claude", "settings.json"), "utf-8"),
    ) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins).toEqual({ "p@m": true });
  });
});
