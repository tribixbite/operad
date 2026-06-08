/**
 * memory-injector.test.ts — Unit tests for src/memory-injector.ts
 *
 * Tests three exports:
 *   - parseMemoryBlocks(text)   — pure, highest-value target
 *   - buildMemoryPrompt(...)    — async, reads MemoryDb
 *   - saveMemoriesFromResponse(...)  — writes to MemoryDb, reads back
 *
 * Uses makeFakeContext({ withDb: true }) for all db-requiring tests so
 * no real $HOME writes occur and temp dirs are cleaned up in afterEach.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  parseMemoryBlocks,
  buildMemoryPrompt,
  saveMemoriesFromResponse,
  type ParsedMemoryBlock,
} from "../memory-injector.js";
import { makeFakeContext, type FakeContext } from "./helpers/fake-context.js";

// ---------------------------------------------------------------------------
// parseMemoryBlocks — pure function, no db needed
// ---------------------------------------------------------------------------

describe("parseMemoryBlocks — valid single block", () => {
  test("parses a block with explicit category", () => {
    const text = "Some text\n```memory\ncategory: convention\nAlways use async/await\n```\nMore text";
    const blocks = parseMemoryBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].category).toBe("convention");
    expect(blocks[0].content).toBe("Always use async/await");
  });

  test("defaults category to discovery when no category line", () => {
    const text = "```memory\nThis is a discovery without explicit category\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].category).toBe("discovery");
    expect(blocks[0].content).toBe("This is a discovery without explicit category");
  });

  test("parses decision category", () => {
    const text = "```memory\ncategory: decision\nChose SQLite over Redis for simplicity\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks[0].category).toBe("decision");
    expect(blocks[0].content).toBe("Chose SQLite over Redis for simplicity");
  });

  test("parses warning category", () => {
    const text = "```memory\ncategory: warning\nNever call stop;start over wifi-adb\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks[0].category).toBe("warning");
    expect(blocks[0].content).toBe("Never call stop;start over wifi-adb");
  });

  test("parses user_preference category", () => {
    const text = "```memory\ncategory: user_preference\nPrefers dark mode always\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks[0].category).toBe("user_preference");
    expect(blocks[0].content).toBe("Prefers dark mode always");
  });

  test("category match is case-insensitive", () => {
    const text = "```memory\ncategory: WARNING\nDo not reset --hard\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks[0].category).toBe("warning");
  });
});

describe("parseMemoryBlocks — multiple blocks", () => {
  test("extracts two blocks from a response", () => {
    const text = [
      "Preamble",
      "```memory",
      "category: convention",
      "Use ES modules",
      "```",
      "Middle text",
      "```memory",
      "category: warning",
      "Avoid /tmp on Termux",
      "```",
      "End",
    ].join("\n");

    const blocks = parseMemoryBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].category).toBe("convention");
    expect(blocks[0].content).toBe("Use ES modules");
    expect(blocks[1].category).toBe("warning");
    expect(blocks[1].content).toBe("Avoid /tmp on Termux");
  });

  test("handles three blocks with mixed categories", () => {
    const text = [
      "```memory\ncategory: decision\nDecision A\n```",
      "```memory\ncategory: discovery\nDiscovery B\n```",
      "```memory\ncategory: user_preference\nPref C\n```",
    ].join("\n\n");

    const blocks = parseMemoryBlocks(text);
    expect(blocks).toHaveLength(3);
    const cats = blocks.map((b) => b.category);
    expect(cats).toEqual(["decision", "discovery", "user_preference"]);
  });
});

describe("parseMemoryBlocks — malformed and edge cases", () => {
  test("returns empty array for text with no memory blocks", () => {
    expect(parseMemoryBlocks("Hello world, no fences here.")).toHaveLength(0);
  });

  test("returns empty array for empty string", () => {
    expect(parseMemoryBlocks("")).toHaveLength(0);
  });

  test("ignores a block that has only whitespace content", () => {
    const text = "```memory\ncategory: convention\n   \n```";
    expect(parseMemoryBlocks(text)).toHaveLength(0);
  });

  test("ignores an empty block", () => {
    const text = "```memory\n```";
    expect(parseMemoryBlocks(text)).toHaveLength(0);
  });

  test("falls back to discovery for an invalid category", () => {
    const text = "```memory\ncategory: not_a_real_category\nsome content\n```";
    const blocks = parseMemoryBlocks(text);
    // Invalid category → contentStart stays 0 but no category match, defaults to discovery
    expect(blocks).toHaveLength(1);
    expect(blocks[0].category).toBe("discovery");
    // Content includes the category line since it wasn't consumed
    expect(blocks[0].content).toContain("some content");
  });

  test("handles multi-line content inside a block", () => {
    const text = "```memory\ncategory: discovery\nLine one\nLine two\nLine three\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("Line one");
    expect(blocks[0].content).toContain("Line two");
    expect(blocks[0].content).toContain("Line three");
  });

  test("does not match regular non-memory fenced blocks", () => {
    const text = "```typescript\nconst x = 1;\n```\n```json\n{\"a\":1}\n```";
    expect(parseMemoryBlocks(text)).toHaveLength(0);
  });

  test("handles surrounding prose and one valid block", () => {
    const prose = "Here is the result of my analysis.\n\nThe build system works well.\n\n";
    const block = "```memory\ncategory: convention\nUse bun run build, not bun build.cjs\n```";
    const suffix = "\n\nLet me know if you want more.";
    const blocks = parseMemoryBlocks(prose + block + suffix);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("bun run build");
  });

  test("whitespace-only category line still triggers default", () => {
    // No category line at all
    const text = "```memory\nThis has no category: line at all\n```";
    const blocks = parseMemoryBlocks(text);
    expect(blocks[0].category).toBe("discovery");
  });
});

// ---------------------------------------------------------------------------
// buildMemoryPrompt — async, reads db
// ---------------------------------------------------------------------------

let fc: FakeContext;

beforeEach(async () => {
  fc = await makeFakeContext({ withDb: true });
});
afterEach(() => fc.cleanup());

describe("buildMemoryPrompt — no memories", () => {
  test("returns null prompt and count=0 when no memories exist", async () => {
    const result = await buildMemoryPrompt(fc.db!, "/proj/empty", 10);
    expect(result.prompt).toBeNull();
    expect(result.count).toBe(0);
  });

  test("returns null for a different project path than was seeded", async () => {
    fc.db!.createMemory("/proj/A", "convention", "Use TypeScript");
    const result = await buildMemoryPrompt(fc.db!, "/proj/B", 10);
    expect(result.prompt).toBeNull();
    expect(result.count).toBe(0);
  });
});

describe("buildMemoryPrompt — with seeded memories", () => {
  test("returns non-null prompt when memories exist", async () => {
    fc.db!.createMemory("/proj/test", "convention", "Always use async/await");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    expect(result.prompt).not.toBeNull();
    expect(result.count).toBe(1);
  });

  test("prompt contains the '## Project Memory' header", async () => {
    fc.db!.createMemory("/proj/test", "discovery", "SQLite WAL mode is faster");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    expect(result.prompt).toContain("## Project Memory");
  });

  test("prompt contains the seeded memory content", async () => {
    fc.db!.createMemory("/proj/test", "warning", "Never call stop;start over wifi");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    expect(result.prompt).toContain("Never call stop;start over wifi");
  });

  test("prompt groups memories by category with correct headings", async () => {
    fc.db!.createMemory("/proj/test", "warning", "Check the lock file");
    fc.db!.createMemory("/proj/test", "convention", "Use bun, not npm");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    const p = result.prompt!;
    expect(p).toContain("### Warnings");
    expect(p).toContain("### Conventions");
  });

  test("prompt includes the instruction to save new memories via fenced block", async () => {
    fc.db!.createMemory("/proj/test", "decision", "Chose TOML over JSON for config");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    expect(result.prompt).toContain("```memory");
    expect(result.prompt).toContain("category:");
  });

  test("respects the limit parameter", async () => {
    for (let i = 0; i < 8; i++) {
      fc.db!.createMemory("/proj/test", "discovery", `Discovery ${i}`);
    }
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 3);
    // count reflects what was returned (capped at limit)
    expect(result.count).toBeLessThanOrEqual(3);
  });

  test("with userMessage, relevant search results are merged in", async () => {
    fc.db!.createMemory("/proj/test", "convention", "Use strict TypeScript");
    fc.db!.createMemory("/proj/test", "discovery", "Performance benchmark result");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10, "typescript types");
    // Should still get a non-null prompt (at minimum the top memories)
    expect(result.prompt).not.toBeNull();
    expect(result.count).toBeGreaterThan(0);
  });

  test("count equals the number of memories returned (multiple categories)", async () => {
    fc.db!.createMemory("/proj/test", "convention", "A");
    fc.db!.createMemory("/proj/test", "warning", "B");
    fc.db!.createMemory("/proj/test", "decision", "C");
    const result = await buildMemoryPrompt(fc.db!, "/proj/test", 10);
    expect(result.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// saveMemoriesFromResponse — writes to db, reads back
// ---------------------------------------------------------------------------

describe("saveMemoriesFromResponse — no blocks in text", () => {
  test("returns 0 when no memory blocks are found", () => {
    const saved = saveMemoriesFromResponse(fc.db!, "/proj/test", "No fences here at all.");
    expect(saved).toBe(0);
  });

  test("returns 0 for empty input", () => {
    const saved = saveMemoriesFromResponse(fc.db!, "/proj/test", "");
    expect(saved).toBe(0);
  });
});

describe("saveMemoriesFromResponse — saves parsed blocks", () => {
  test("saves a single memory block and returns 1", () => {
    const text = "```memory\ncategory: convention\nAlways write tests first\n```";
    const saved = saveMemoriesFromResponse(fc.db!, "/proj/test", text);
    expect(saved).toBe(1);
  });

  test("saved memory is retrievable via getTopMemories", () => {
    const text = "```memory\ncategory: warning\nDo not run as root\n```";
    saveMemoriesFromResponse(fc.db!, "/proj/test", text);
    const memories = fc.db!.getTopMemories("/proj/test", 10);
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe("Do not run as root");
    expect(memories[0].category).toBe("warning");
  });

  test("saves multiple blocks in one response", () => {
    const text = [
      "Here are my learnings:",
      "```memory",
      "category: decision",
      "Decision one",
      "```",
      "```memory",
      "category: discovery",
      "Discovery two",
      "```",
    ].join("\n");
    const saved = saveMemoriesFromResponse(fc.db!, "/proj/test", text);
    expect(saved).toBe(2);
    const memories = fc.db!.getTopMemories("/proj/test", 10);
    expect(memories.length).toBe(2);
  });

  test("duplicate content is not double-saved (returns 0 for second call)", () => {
    const text = "```memory\ncategory: convention\nDuplicate content\n```";
    const first = saveMemoriesFromResponse(fc.db!, "/proj/test", text);
    const second = saveMemoriesFromResponse(fc.db!, "/proj/test", text);
    expect(first).toBe(1);
    expect(second).toBe(0); // duplicate deduplication
  });

  test("sessionId is stored on the created memory", () => {
    const text = "```memory\ncategory: discovery\nSession-tagged discovery\n```";
    saveMemoriesFromResponse(fc.db!, "/proj/test", text, "sess-abc-123");
    const memories = fc.db!.getTopMemories("/proj/test", 10);
    expect(memories[0].source_session_id).toBe("sess-abc-123");
  });

  test("memories saved for different projects don't cross-contaminate", () => {
    const textA = "```memory\ncategory: convention\nFor project A only\n```";
    const textB = "```memory\ncategory: convention\nFor project B only\n```";
    saveMemoriesFromResponse(fc.db!, "/proj/A", textA);
    saveMemoriesFromResponse(fc.db!, "/proj/B", textB);

    const memA = fc.db!.getTopMemories("/proj/A", 10);
    const memB = fc.db!.getTopMemories("/proj/B", 10);
    expect(memA.length).toBe(1);
    expect(memA[0].content).toBe("For project A only");
    expect(memB.length).toBe(1);
    expect(memB[0].content).toBe("For project B only");
  });
});
