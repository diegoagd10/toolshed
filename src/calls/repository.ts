import { desc } from 'drizzle-orm'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { keyId } from '../keys/repository.js'

export const calls = sqliteTable('calls', {
  id: integer()
    .primaryKey(),
  at: text()
    .notNull(),
  keyId: text('key_id')
    .notNull()
    .references(keyId),
  tool: text()
    .notNull(),
  via: text({ enum: ['rest', 'mcp'] })
    .notNull(),
  ms: integer()
    .notNull(),
  error: text(),
})

export type Call = Omit<typeof calls.$inferSelect, 'id'>

const shown = {
  at: calls.at,
  keyId: calls.keyId,
  tool: calls.tool,
  via: calls.via,
  ms: calls.ms,
  error: calls.error,
}

export class CallsRepository {
  readonly #database

  constructor(database: NodeSQLiteDatabase) {
    this.#database = database
  }

  record(call: Call) {
    this.#database.insert(calls)
      .values(call)
      .run()
  }

  recent(limit: number): Call[] {
    return this.#database.select(shown)
      .from(calls)
      .orderBy(desc(calls.id))
      .limit(limit)
      .all()
  }
}
