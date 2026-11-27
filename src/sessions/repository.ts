import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Only the token's hash is stored, so the disk alone does not sign anyone in.
export const sessions = sqliteTable('sessions', {
  hash: text()
    .primaryKey(),
  expiresAt: integer('expires_at')
    .notNull(),
})

export class SessionsRepository {
  readonly #database

  constructor(database: BetterSQLite3Database) {
    this.#database = database
  }

  // Opening a session also forgets the expired ones, so the table stays small.
  open(lifetimeMs: number) {
    const token = randomBytes(32)
      .toString('base64url')
    const now = Date.now()
    this.#database.delete(sessions)
      .where(lte(sessions.expiresAt, now))
      .run()
    this.#database.insert(sessions)
      .values({ hash: hashOf(token), expiresAt: now + lifetimeMs })
      .run()
    return token
  }

  valid(token: string) {
    const found = this.#database.select({ hash: sessions.hash })
      .from(sessions)
      .where(and(eq(sessions.hash, hashOf(token)), gt(sessions.expiresAt, Date.now())))
      .get()
    return found !== undefined
  }

  close(token: string) {
    this.#database.delete(sessions)
      .where(eq(sessions.hash, hashOf(token)))
      .run()
  }
}

// A plain hash is enough because the token is 256 random bits.
function hashOf(token: string) {
  return createHash('sha256')
    .update(token)
    .digest('hex')
}
