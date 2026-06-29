/**
 * D1 Database Connection Utility
 * 
 * Provides connection utilities for Cloudflare D1 database in Workers environment.
 * This module handles D1 database access with proper error handling and type safety.
 * 
 * Requirements: 3.2, 3.3
 */

/**
 * D1 Database interface from Cloudflare Workers
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    served_by: string;
  };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

/**
 * Environment interface for Cloudflare Workers with D1 bindings
 */
export interface D1Env {
  DB: D1Database;        // Main analytics database
  ADMIN_DB?: D1Database; // Admin database (admin_users, feedback, etc.)
}

/**
 * Query result wrapper with error information
 */
export interface QueryResult<T> {
  data: T[] | null;
  error: string | null;
  meta?: {
    duration: number;
    changes: number;
    lastRowId: number;
  };
}

/**
 * Single row query result wrapper
 */
export interface SingleQueryResult<T> {
  data: T | null;
  error: string | null;
}

/**
 * Execute result wrapper
 */
export interface ExecuteResult {
  success: boolean;
  error: string | null;
  changes?: number;
  lastRowId?: number;
}

/**
 * Get D1 database instance from Cloudflare Workers environment
 * 
 * In Cloudflare Workers/Pages, the D1 database is accessed via environment bindings.
 * This function retrieves the database from the global context or passed environment.
 * 
 * @param env - Optional environment object with D1 binding
 * @returns D1Database instance
 * @throws Error if D1 database is not available
 */
export function getD1Database(env?: D1Env): D1Database {
  // First, check if env is passed directly (preferred in Workers)
  if (env?.DB) {
    return env.DB;
  }

  // Local/VPS fallback: use a SQLite file when DATABASE_BACKEND=sqlite.
  // (Shim + better-sqlite3 are lazy-required so they never enter the CF build.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shouldUseSqlite, getSqliteD1 } = require('./d1-sqlite-shim');
  if (shouldUseSqlite()) {
    return getSqliteD1('flyx-analytics');
  }

  // Try OpenNext's getCloudflareContext (preferred method for Next.js on Cloudflare)
  try {
    // Dynamic import to avoid build errors when not in Cloudflare environment
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require('@opennextjs/cloudflare');
    const ctx = getCloudflareContext({ async: false });
    if (ctx?.env?.DB) {
      return ctx.env.DB as D1Database;
    }
  } catch (e) {
    // getCloudflareContext not available or failed, try other methods
    console.debug('[D1] getCloudflareContext failed:', e instanceof Error ? e.message : e);
  }

  // Check for D1 in global context (set by OpenNext/Cloudflare Pages)
  const globalEnv = (globalThis as unknown as { process?: { env?: D1Env } })?.process?.env;
  if (globalEnv?.DB) {
    return globalEnv.DB;
  }

  // Check for cloudflare context (Next.js on Cloudflare Pages)
  const cfContext = (globalThis as unknown as { __cf_env__?: D1Env })?.__cf_env__;
  if (cfContext?.DB) {
    return cfContext.DB;
  }

  throw new Error(
    'D1 database not available. Ensure you are running in Cloudflare Workers/Pages environment ' +
    'with D1 binding configured in wrangler.toml'
  );
}

/**
 * Get Admin D1 database instance from Cloudflare Workers environment
 * Used for admin_users, feedback, and other admin-related tables
 * 
 * @param env - Optional environment object with D1 binding
 * @returns D1Database instance for admin operations
 * @throws Error if Admin D1 database is not available
 */
export function getAdminD1Database(env?: D1Env): D1Database {
  // First, check if env is passed directly (preferred in Workers)
  if (env?.ADMIN_DB) {
    return env.ADMIN_DB;
  }

  // Local/VPS fallback: separate SQLite file for admin tables.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shouldUseSqlite, getSqliteD1 } = require('./d1-sqlite-shim');
  if (shouldUseSqlite()) {
    return getSqliteD1('flyx-admin');
  }

  // Try OpenNext's getCloudflareContext (preferred method for Next.js on Cloudflare)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require('@opennextjs/cloudflare');
    const ctx = getCloudflareContext({ async: false });
    if (ctx?.env?.ADMIN_DB) {
      return ctx.env.ADMIN_DB as D1Database;
    }
  } catch (e) {
    console.debug('[D1] getCloudflareContext for ADMIN_DB failed:', e instanceof Error ? e.message : e);
  }

  // Check for D1 in global context
  const globalEnv = (globalThis as unknown as { process?: { env?: D1Env } })?.process?.env;
  if (globalEnv?.ADMIN_DB) {
    return globalEnv.ADMIN_DB;
  }

  // Check for cloudflare context
  const cfContext = (globalThis as unknown as { __cf_env__?: D1Env })?.__cf_env__;
  if (cfContext?.ADMIN_DB) {
    return cfContext.ADMIN_DB;
  }

  // Fallback to main DB if ADMIN_DB not available (for backwards compatibility)
  console.warn('[D1] ADMIN_DB not available, falling back to main DB');
  return getD1Database(env);
}

/**
 * Check if D1 database is available in the current environment
 * 
 * @param env - Optional environment object with D1 binding
 * @returns true if D1 is available, false otherwise
 */
export function isD1Available(env?: D1Env): boolean {
  try {
    getD1Database(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a query and return all results with error handling
 * 
 * @param sql - SQL query string with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns QueryResult with data array or error
 */
export async function queryD1<T = unknown>(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<QueryResult<T>> {
  try {
    const db = getD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.all<T>();

    return {
      data: result.results,
      error: null,
      meta: {
        duration: result.meta.duration,
        changes: result.meta.changes,
        lastRowId: result.meta.last_row_id,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('D1 query error:', errorMessage, { sql, params });
    return {
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Execute a query and return the first result with error handling
 * 
 * @param sql - SQL query string with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns SingleQueryResult with single row or null
 */
export async function queryD1First<T = unknown>(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<SingleQueryResult<T>> {
  try {
    const db = getD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.first<T>();

    return {
      data: result,
      error: null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('D1 query error:', errorMessage, { sql, params });
    return {
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Execute a write operation (INSERT, UPDATE, DELETE) with error handling
 * 
 * @param sql - SQL statement with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns ExecuteResult with success status and metadata
 */
export async function executeD1(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<ExecuteResult> {
  try {
    const db = getD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.run();

    return {
      success: result.success,
      error: null,
      changes: result.meta.changes,
      lastRowId: result.meta.last_row_id,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('D1 execute error:', errorMessage, { sql, params });
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Execute multiple statements in a batch for better performance
 * 
 * @param statements - Array of { sql, params } objects
 * @param env - Optional environment object with D1 binding
 * @returns Array of results for each statement
 */
export async function batchD1<T = unknown>(
  statements: Array<{ sql: string; params?: unknown[] }>,
  env?: D1Env
): Promise<QueryResult<T>[]> {
  try {
    const db = getD1Database(env);
    const preparedStatements = statements.map(({ sql, params = [] }) => {
      const stmt = db.prepare(sql);
      return params.length > 0 ? stmt.bind(...params) : stmt;
    });

    const results = await db.batch<T>(preparedStatements);

    return results.map((result) => ({
      data: result.results,
      error: null,
      meta: {
        duration: result.meta.duration,
        changes: result.meta.changes,
        lastRowId: result.meta.last_row_id,
      },
    }));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('D1 batch error:', errorMessage);
    return statements.map(() => ({
      data: null,
      error: errorMessage,
    }));
  }
}

/**
 * Execute raw SQL (useful for schema operations)
 * Note: This doesn't support parameter binding
 * 
 * @param sql - Raw SQL to execute
 * @param env - Optional environment object with D1 binding
 * @returns ExecuteResult with success status
 */
export async function execD1(
  sql: string,
  env?: D1Env
): Promise<ExecuteResult> {
  try {
    const db = getD1Database(env);
    const result = await db.exec(sql);

    return {
      success: true,
      error: null,
      changes: result.count,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('D1 exec error:', errorMessage, { sql });
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Helper to safely convert D1 results to typed objects
 * Handles null/undefined values and type coercion
 * 
 * @param row - Raw row from D1 query
 * @returns Typed object or null
 */
export function safeRowConvert<T>(row: unknown): T | null {
  if (row === null || row === undefined) {
    return null;
  }
  return row as T;
}

/**
 * Transaction helper - executes multiple statements atomically
 * D1 doesn't have explicit transactions, but batch operations are atomic
 * 
 * @param operations - Array of { sql, params } to execute atomically
 * @param env - Optional environment object with D1 binding
 * @returns Success status and any errors
 */
export async function transactionD1(
  operations: Array<{ sql: string; params?: unknown[] }>,
  env?: D1Env
): Promise<{ success: boolean; error: string | null }> {
  const results = await batchD1(operations, env);
  const errors = results.filter((r) => r.error !== null);

  if (errors.length > 0) {
    return {
      success: false,
      error: errors.map((e) => e.error).join('; '),
    };
  }

  return {
    success: true,
    error: null,
  };
}

// ============================================
// Admin Database Functions
// ============================================

/**
 * Execute a query on the Admin D1 database and return all results
 * Used for admin_users, feedback, and other admin-related tables
 * 
 * @param sql - SQL query string with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns QueryResult with data array or error
 */
export async function queryAdminD1<T = unknown>(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<QueryResult<T>> {
  try {
    const db = getAdminD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.all<T>();

    return {
      data: result.results,
      error: null,
      meta: {
        duration: result.meta.duration,
        changes: result.meta.changes,
        lastRowId: result.meta.last_row_id,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('Admin D1 query error:', errorMessage, { sql, params });
    return {
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Execute a query on the Admin D1 database and return the first result
 * 
 * @param sql - SQL query string with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns SingleQueryResult with single row or null
 */
export async function queryAdminD1First<T = unknown>(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<SingleQueryResult<T>> {
  try {
    const db = getAdminD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.first<T>();

    return {
      data: result,
      error: null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('Admin D1 query error:', errorMessage, { sql, params });
    return {
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Execute a write operation on the Admin D1 database
 * 
 * @param sql - SQL statement with ? placeholders for parameters
 * @param params - Array of parameter values to bind
 * @param env - Optional environment object with D1 binding
 * @returns ExecuteResult with success status and metadata
 */
export async function executeAdminD1(
  sql: string,
  params: unknown[] = [],
  env?: D1Env
): Promise<ExecuteResult> {
  try {
    const db = getAdminD1Database(env);
    const stmt = db.prepare(sql);
    const boundStmt = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await boundStmt.run();

    return {
      success: result.success,
      error: null,
      changes: result.meta.changes,
      lastRowId: result.meta.last_row_id,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown database error';
    console.error('Admin D1 execute error:', errorMessage, { sql, params });
    return {
      success: false,
      error: errorMessage,
    };
  }
}
