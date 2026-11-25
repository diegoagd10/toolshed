import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const keys = sqliteTable('keys', {
  id: text()
    .primaryKey(),
  name: text()
    .notNull(),
  hash: text()
    .notNull()
    .unique(),
  prefix: text()
    .notNull(),
  createdAt: text('created_at')
    .notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
})

// Other tables refer to a key through this.
export function keyId() {
  return keys.id
}

export type Key = Omit<typeof keys.$inferSelect, 'hash'>

const shown = {
  id: keyId(),
  name: keys.name,
  prefix: keys.prefix,
  createdAt: keys.createdAt,
  lastUsedAt: keys.lastUsedAt,
  revokedAt: keys.revokedAt,
}
const shownCharacters = 9
const lastUsedPrecisionMs = 60_000

export class KeysRepository {
  readonly #database

  constructor(database: BetterSQLite3Database) {
    this.#database = database
  }

  create(name: string) {
    const secret = `ts_${randomBytes(32)
      .toString('base64url')}`
    const key = this.#database.insert(keys)
      .values({
        id: `key_${randomBytes(8)
          .toString('hex')}`,
        name,
        hash: hashOf(secret),
        prefix: secret.slice(0, shownCharacters),
        createdAt: new Date()
          .toISOString(),
      })
      .returning(shown)
      .get()
    return { key, secret }
  }

  authenticate(secret: string): Key | undefined {
    const key = this.#database.select(shown)
      .from(keys)
      .where(and(eq(keys.hash, hashOf(secret)), isNull(keys.revokedAt)))
      .get()
    if (key) this.#touch(key.id)
    return key
  }

  revoke(id: string) {
    this.#database.update(keys)
      .set({ revokedAt: new Date()
        .toISOString() })
      .where(and(eq(keyId(), id), isNull(keys.revokedAt)))
      .run()
  }

  list(): Key[] {
    return this.#database.select(shown)
      .from(keys)
      .orderBy(asc(keys.createdAt), sql`rowid`)
      .all()
  }

  // Writes at most once a minute per key, so that a call does not wait for the disk.
  #touch(id: string) {
    const now = Date.now()
    const stale = new Date(now - lastUsedPrecisionMs)
      .toISOString()
    this.#database.update(keys)
      .set({ lastUsedAt: new Date(now)
        .toISOString() })
      .where(and(eq(keyId(), id), or(isNull(keys.lastUsedAt), lt(keys.lastUsedAt, stale))))
      .run()
  }
}

// A plain hash is enough because the secret is 256 random bits.
function hashOf(secret: string) {
  return createHash('sha256')
    .update(secret)
    .digest('hex')
}
