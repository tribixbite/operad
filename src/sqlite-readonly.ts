/**
 * sqlite-readonly.ts — synchronous, read-only access to SQLite databases
 * that belong to OTHER programs (e.g. Antigravity's conversation index).
 *
 * memory-db.ts's opener is the wrong tool for this: it is async, and it
 * switches the database to WAL mode and enables foreign keys, which are
 * writes. A database another tool owns must never be modified by operad,
 * and the monitoring poll that reads it is synchronous.
 *
 * Drivers are tried in order — bun:sqlite (built in under bun), node:sqlite
 * (built in on node 22.5+), better-sqlite3 (optional dependency) — and each
 * is opened read-only. Any failure (no driver, missing file, locked, corrupt)
 * yields null: callers treat "can't read it" as "no answer", never as an
 * error worth stopping for.
 */

/** The little a read-only consumer needs: run a query, close. */
export interface ReadonlySqlite {
  all(sql: string, ...params: Array<string | number>): Record<string, unknown>[];
  close(): void;
}

type Opener = (path: string) => ReadonlySqlite;

/** bun:sqlite, available whenever the process runs under bun. */
const openWithBun: Opener = (path) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  return {
    // prepare + finalize, not db.query(): query() caches the statement on the
    // connection, and a connection with a live statement is not released by
    // close(). On Windows the file then stays open, so the owning tool (and a
    // test's temp-dir cleanup) gets EBUSY.
    all: (sql, ...params) => {
      const stmt = db.prepare(sql);
      try {
        return stmt.all(...params) as Record<string, unknown>[];
      } finally {
        stmt.finalize();
      }
    },
    close: () => db.close(),
  };
};

/** node:sqlite (`DatabaseSync`), built into node 22.5 and later. */
const openWithNode: Opener = (path) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string, o: { readOnly: boolean }) => {
      prepare(sql: string): { all(...p: unknown[]): unknown[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    close: () => db.close(),
  };
};

/** better-sqlite3, when installed. */
const openWithBetterSqlite: Opener = (path) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("better-sqlite3") as { default?: unknown };
  const Database = (mod.default ?? mod) as new (p: string, o: { readonly: boolean; fileMustExist: boolean }) => {
    prepare(sql: string): { all(...p: unknown[]): unknown[] };
    close(): void;
  };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    close: () => db.close(),
  };
};

/**
 * Open `path` read-only with the first driver that works, or return null.
 *
 * The file's existence is checked by the drivers themselves in read-only
 * mode (none of them creates a missing file when opened read-only).
 */
export function openReadonlySqlite(path: string): ReadonlySqlite | null {
  const openers: Opener[] = [];
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") openers.push(openWithBun);
  openers.push(openWithNode, openWithBetterSqlite);
  for (const open of openers) {
    try {
      return open(path);
    } catch {
      // Next driver. A missing/corrupt file fails every driver the same way,
      // which ends in null below.
    }
  }
  return null;
}

/**
 * Run one query against a database read-only and close it again. Returns
 * null when the database can't be opened or the query fails.
 */
export function queryReadonly(
  path: string,
  sql: string,
  ...params: Array<string | number>
): Record<string, unknown>[] | null {
  const db = openReadonlySqlite(path);
  if (!db) return null;
  try {
    return db.all(sql, ...params);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}
