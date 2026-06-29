/**
 * D1 → better-sqlite3 shim
 *
 * Implements Cloudflare's D1Database interface on top of a local SQLite file
 * (better-sqlite3), so the D1-coupled code paths (IPTV accounts, admin auth,
 * banner, feedback) run unchanged on a plain Node.js VPS where no D1 binding
 * exists.
 *
 * Only loaded when DATABASE_BACKEND=sqlite (set in the Docker/VPS env). The
 * native `better-sqlite3` / `node:*` modules are pulled in via `eval('require')`
 * so webpack/OpenNext never bundles them into the Cloudflare Worker build.
 */

import type { D1Database, D1Result } from './d1-connection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyRequire(mod: string): any {
  // eval('require') is opaque to the bundler — keeps native deps out of the
  // Worker build while resolving normally in Node.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
  return (eval('require') as NodeRequire)(mod);
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/** Normalize a JS value into something better-sqlite3 will bind without throwing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeParam(v: any): any {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class SqliteStatement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private driver: any, private sql: string, private params: any[] = []) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bind(...values: any[]): SqliteStatement {
    return new SqliteStatement(this.driver, this.sql, values.map(normalizeParam));
  }

  /** Synchronous core — used by all(), run(), first(), and batch(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _exec<T = any>(): D1Result<T> {
    const start = nowMs();
    const stmt = this.driver.prepare(this.sql);
    let results: T[] = [];
    let changes = 0;
    let lastRowId = 0;

    if (stmt.reader) {
      results = stmt.all(...this.params) as T[];
    } else {
      const info = stmt.run(...this.params);
      changes = info.changes ?? 0;
      lastRowId = typeof info.lastInsertRowid === 'bigint'
        ? Number(info.lastInsertRowid)
        : (info.lastInsertRowid ?? 0);
    }

    return {
      results,
      success: true,
      meta: { duration: nowMs() - start, changes, last_row_id: lastRowId, served_by: 'sqlite-shim' },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async all<T = any>(): Promise<D1Result<T>> {
    return this._exec<T>();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async first<T = any>(colName?: string): Promise<T | null> {
    const row = this._exec<Record<string, unknown>>().results[0];
    if (row == null) return null;
    if (colName != null) return (row[colName] ?? null) as T;
    return row as unknown as T;
  }

  async run(): Promise<D1Result> {
    const r = this._exec();
    return { ...r, results: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async raw<T = any>(): Promise<T[]> {
    const stmt = this.driver.prepare(this.sql).raw();
    return stmt.reader ? (stmt.all(...this.params) as T[]) : [];
  }
}

class SqliteD1 implements D1Database {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private driver: any) {}

  prepare(query: string) {
    return new SqliteStatement(this.driver, query) as unknown as ReturnType<D1Database['prepare']>;
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported by the SQLite shim');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async batch<T = unknown>(statements: any[]): Promise<D1Result<T>[]> {
    // D1 batches are atomic — run them inside one better-sqlite3 transaction.
    const txn = this.driver.transaction((stmts: SqliteStatement[]) =>
      stmts.map((s) => s._exec<T>())
    );
    return txn(statements);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = nowMs();
    this.driver.exec(query);
    return { count: 0, duration: nowMs() - start };
  }
}

const instances = new Map<string, SqliteD1>();

/**
 * Get (or open) a SQLite-backed D1Database by logical name.
 * Files live under SQLITE_DATA_DIR (default ./data), e.g. ./data/flyx-admin.db
 */
export function getSqliteD1(name: string): D1Database {
  const existing = instances.get(name);
  if (existing) return existing as unknown as D1Database;

  const Database = lazyRequire('better-sqlite3');
  const fs = lazyRequire('node:fs');
  const path = lazyRequire('node:path');

  const dir = process.env.SQLITE_DATA_DIR || './data';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.db`);

  const driver = new Database(file);
  driver.pragma('journal_mode = WAL');
  driver.pragma('foreign_keys = ON');
  driver.pragma('busy_timeout = 5000');

  const d1 = new SqliteD1(driver);
  instances.set(name, d1);
  return d1 as unknown as D1Database;
}

/** True when the app should use the local SQLite shim instead of a D1 binding. */
export function shouldUseSqlite(): boolean {
  return process.env.DATABASE_BACKEND === 'sqlite';
}
