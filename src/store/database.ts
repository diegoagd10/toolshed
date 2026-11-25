import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StoreError } from './error.js'

// Released migrations never change. A new version adds one at the end.
const migrations = [
  `CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    key_id TEXT NOT NULL REFERENCES keys (id),
    tool TEXT NOT NULL,
    via TEXT NOT NULL,
    ms INTEGER NOT NULL,
    error TEXT
  ) STRICT;`,
  `CREATE TABLE files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) STRICT;`,
]

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, 'toolshed.db')
  const database = new DatabaseSync(path, { timeout: 5000 })
  try {
    chmodSync(path, 0o600)
    database.exec('PRAGMA synchronous = FULL')
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function migrate(database: DatabaseSync) {
  database.exec('BEGIN IMMEDIATE')
  const version = Number(database.prepare('PRAGMA user_version')
    .get()?.user_version)
  if (version > migrations.length) {
    throw new StoreError('database_too_new', `the database has version ${version}, newer than ${migrations.length}`)
  }
  for (const migration of migrations.slice(version)) database.exec(migration)
  database.exec(`PRAGMA user_version = ${migrations.length}; COMMIT`)
}
