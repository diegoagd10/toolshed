import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { CallsRepository } from '../calls/repository.js'
import { FilesRepository } from '../files/repository.js'
import { KeysRepository } from '../keys/repository.js'
import { Links } from '../links/links.js'
import { LinksRepository } from '../links/repository.js'
import { StoreError } from './error.js'

const lockTimeoutMs = 5000

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const client = open(join(dataDir, 'toolshed.db'))
  try {
    client.pragma('synchronous = FULL')
    const database = drizzle({ client })
    migrateAlone(database, join(dataDir, 'migrate.lock'))
    return {
      keys: new KeysRepository(database),
      calls: new CallsRepository(database),
      files: new FilesRepository(database, dataDir),
      links: new Links(new LinksRepository(database)
        .secret()),
      close() {
        client.close()
      },
    }
  } catch (error) {
    client.close()
    throw error
  }
}

export type Store = ReturnType<typeof openStore>

function open(path: string) {
  const client = new Database(path, { timeout: lockTimeoutMs })
  chmodSync(path, 0o600)
  return client
}

// Drizzle reads the applied migrations outside its transaction, so two processes could both
// apply the same one. SQLite's lock on a separate file is released even if the process dies.
function migrateAlone(database: BetterSQLite3Database, lockPath: string) {
  // Computed here because drizzle-kit loads this file as CommonJS, without import.meta.
  const migrationsFolder = join(import.meta.dirname, '../drizzle')
  const lock = open(lockPath)
  try {
    lock.exec('BEGIN EXCLUSIVE')
    migrate(database, { migrationsFolder })
  } finally {
    lock.close()
  }
  const known = readMigrationFiles({ migrationsFolder })
    .map(({ hash }) => hash)
  const applied = database.all<{ hash: string }>(sql`SELECT hash FROM __drizzle_migrations`)
  const unknown = applied.filter(({ hash }) => !known.includes(hash)).length
  if (unknown > 0) {
    throw new StoreError('database_too_new', `the database has ${unknown} unknown migrations`)
  }
}
