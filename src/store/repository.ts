import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { CallsRepository } from '../calls/repository.js'
import { FilesRepository } from '../files/repository.js'
import { KeysRepository } from '../keys/repository.js'
import { Links } from '../links/links.js'
import { LinksRepository } from '../links/repository.js'
import { StoreError } from './error.js'

const migrationsFolder = join(import.meta.dirname, '../drizzle')
const lockTimeoutMs = 5000

export function openStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const client = open(join(dataDir, 'toolshed.db'))
  try {
    client.exec('PRAGMA synchronous = FULL')
    const database = drizzle({ client, paramsInErrors: false })
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
  const client = new DatabaseSync(path, { timeout: lockTimeoutMs })
  chmodSync(path, 0o600)
  return client
}

// Drizzle reads the applied migrations outside its transaction, so two processes could both
// apply the same one. SQLite's lock on a separate file is released even if the process dies.
function migrateAlone(database: NodeSQLiteDatabase, lockPath: string) {
  const lock = open(lockPath)
  try {
    lock.exec('BEGIN EXCLUSIVE')
    migrate(database, { migrationsFolder })
  } finally {
    lock.close()
  }
  const known = readMigrationFiles({ migrationsFolder })
    .map(({ name }) => name)
  const applied = database.all<{ name: string }>(sql`SELECT name FROM __drizzle_migrations`)
  const unknown = applied.find(({ name }) => !known.includes(name))
  if (unknown) {
    throw new StoreError('database_too_new', `the database has the unknown migration ${unknown.name}`)
  }
}
