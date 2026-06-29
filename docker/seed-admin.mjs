#!/usr/bin/env node
/**
 * Seed an admin user into the local SQLite admin DB (VPS / DATABASE_BACKEND=sqlite).
 *
 * The hash format must match app/lib/utils/admin-auth.ts exactly:
 *   PBKDF2-SHA256, 100000 iterations, 16-byte salt, 32-byte key,
 *   stored as base64(salt(16) || key(32)).
 *
 * Usage (inside the container):
 *   docker compose exec flyx node /app/scripts/seed-admin.mjs <username> <password>
 *
 * Usage (host, against ./data):
 *   SQLITE_DATA_DIR=./data node docker/seed-admin.mjs <username> <password>
 */
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Usage: node scripts/seed-admin.mjs <username> <password>');
  process.exit(1);
}

const dir = process.env.SQLITE_DATA_DIR || './data';
const file = path.join(dir, 'flyx-admin.db');

// Match admin-auth.ts hashPassword(): base64(salt || pbkdf2(pw, salt, 100k, 32, sha256))
const salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
const passwordHash = Buffer.concat([salt, key]).toString('base64');

let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('better-sqlite3 not found. Run this inside the container, or `npm i better-sqlite3` on the host.');
  process.exit(1);
}

const db = new Database(file);
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_login INTEGER
  );
`);

const id = crypto.randomUUID();
db.prepare(
  `INSERT INTO admin_users (id, username, password_hash) VALUES (?, ?, ?)
   ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
).run(id, username, passwordHash);

console.log(`✓ Admin user '${username}' seeded into ${file}`);
