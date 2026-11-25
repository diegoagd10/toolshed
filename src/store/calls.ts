import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const callSchema = z.object({
  at: z.string(),
  keyId: z.string(),
  tool: z.string(),
  via: z.enum(['rest', 'mcp']),
  ms: z.int(),
  error: z.string()
    .nullable(),
})

export type Call = z.output<typeof callSchema>

export class Calls {
  readonly #insert
  readonly #recent

  constructor(database: DatabaseSync) {
    this.#insert = database.prepare(`INSERT INTO calls (at, key_id, tool, via, ms, error)
      VALUES (?, ?, ?, ?, ?, ?)`)
    this.#recent = database.prepare(`SELECT at, key_id AS keyId, tool, via, ms, error
      FROM calls ORDER BY id DESC LIMIT ?`)
  }

  record({ at, keyId, tool, via, ms, error }: Call) {
    this.#insert.run(at, keyId, tool, via, ms, error)
  }

  recent(limit: number): Call[] {
    return z.array(callSchema)
      .parse(this.#recent.all(limit))
  }
}
