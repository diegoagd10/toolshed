import { randomBytes } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { blob, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const secrets = sqliteTable('secrets', {
  name: text()
    .primaryKey(),
  value: blob({ mode: 'buffer' })
    .notNull(),
})

const name = 'links'

export class LinksRepository {
  readonly #database

  constructor(database: BetterSQLite3Database) {
    this.#database = database
  }

  // The first call creates the secret. Links outlive a restart because it is stored.
  secret() {
    const created = { name, value: randomBytes(32) }
    const { value } = this.#database.insert(secrets)
      .values(created)
      .onConflictDoUpdate({ target: secrets.name, set: { name } })
      .returning()
      .get()
    return value
  }
}
