/**
 * memory-injector.ts — Memory prompt builder and response parser
 *
 * Builds a "## Project Memory" section to prepend to SDK prompts,
 * and parses ` ```memory ` blocks from assistant responses to auto-save.
 * Memory format compatible with claudeck's block pattern.
 */

import type { MemoryDb, MemoryCategory } from "./memory-db.js";

/** Parsed memory block from assistant response */
export interface ParsedMemoryBlock {
  category: MemoryCategory;
  content: string;
}

/** Valid memory categories */
const VALID_CATEGORIES = new Set<MemoryCategory>([
  "convention",
  "decision",
  "discovery",
  "warning",
  "user_preference",
]);

/**
 * Build a memory prompt to prepend to user messages.
 * Returns null if no memories exist for the project.
 */
export async function buildMemoryPrompt(
  db: MemoryDb,
  projectPath: string,
  limit = 10,
  userMessage?: string,
): Promise<{ prompt: string | null; count: number }> {
  // Get top memories by relevance
  let memories = db.getTopMemories(projectPath, limit);

  // If a user message is provided, also search for relevant memories
  if (userMessage && userMessage.length > 3) {
    const searchResults = db.searchMemories(projectPath, userMessage, 5);
    // Merge search results, deduplicating by ID
    const seenIds = new Set(memories.map((m) => m.id));
    for (const sr of searchResults) {
      if (!seenIds.has(sr.id)) {
        memories.push(sr);
        seenIds.add(sr.id);
      }
    }
    // Re-sort by relevance
    memories.sort((a, b) => b.relevance_score - a.relevance_score);
    // Trim to limit
    memories = memories.slice(0, limit);
  }

  if (memories.length === 0) {
    return { prompt: null, count: 0 };
  }

  // Touch accessed memories (boost relevance)
  for (const m of memories) {
    db.touchMemory(m.id);
  }

  // Group by category
  const grouped = new Map<string, string[]>();
  for (const m of memories) {
    const group = grouped.get(m.category) ?? [];
    group.push(m.content);
    grouped.set(m.category, group);
  }

  // Build the prompt section
  const lines: string[] = [
    "## Project Memory",
    "",
    "The following memories from previous sessions may be relevant:",
    "",
  ];

  const categoryOrder: MemoryCategory[] = [
    "warning",
    "convention",
    "decision",
    "discovery",
    "user_preference",
  ];

  for (const cat of categoryOrder) {
    const items = grouped.get(cat);
    if (!items?.length) continue;

    const label = cat.charAt(0).toUpperCase() + cat.slice(1).replace("_", " ");
    lines.push(`### ${label}s`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // Add instruction for Claude to save new memories
  lines.push("---");
  lines.push("");
  lines.push("To save a new memory for future sessions, output a fenced block:");
  lines.push("```memory");
  lines.push("category: convention|decision|discovery|warning|user_preference");
  lines.push("Your memory content here");
  lines.push("```");
  lines.push("");

  return { prompt: lines.join("\n"), count: memories.length };
}

/**
 * Parse ` ```memory ` blocks from assistant text.
 * Extracts category and content from each block.
 *
 * Format:
 * ```memory
 * category: convention
 * Content text here
 * ```
 */
export function parseMemoryBlocks(text: string): ParsedMemoryBlock[] {
  const blocks: ParsedMemoryBlock[] = [];
  // Match ```memory ... ``` blocks (handle both ``` and ~~~ fences)
  const regex = /```memory\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const blockContent = match[1].trim();
    if (!blockContent) continue;

    const lines = blockContent.split("\n");
    let category: MemoryCategory = "discovery"; // default category
    let contentStart = 0;

    // Check if first line specifies category
    const categoryLine = lines[0].trim();
    const categoryMatch = categoryLine.match(/^category:\s*(\w+)/i);
    if (categoryMatch) {
      const cat = categoryMatch[1].toLowerCase() as MemoryCategory;
      if (VALID_CATEGORIES.has(cat)) {
        category = cat;
      }
      contentStart = 1;
    }

    const content = lines.slice(contentStart).join("\n").trim();
    if (content) {
      blocks.push({ category, content });
    }
  }

  return blocks;
}

/**
 * Process assistant response: extract memory blocks and save them.
 * Returns the number of new memories saved.
 */
export function saveMemoriesFromResponse(
  db: MemoryDb,
  projectPath: string,
  assistantText: string,
  sessionId?: string,
): number {
  const blocks = parseMemoryBlocks(assistantText);
  let saved = 0;

  for (const block of blocks) {
    const id = db.createMemory(projectPath, block.category, block.content, sessionId);
    if (id !== null) saved++;
  }

  return saved;
}
