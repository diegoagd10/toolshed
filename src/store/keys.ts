import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string()
    .nullable(),
  revokedAt: z.string()
    .nullable(),
})

export type Key = z.output<typeof keySchema>

const columns = `id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt,
  revoked_at AS revokedAt`
const shownCharacters = 9
const lastUsedPrecisionMs = 60_000

export class Keys {
  readonly #insert
  readonly #active
  readonly #touch
  readonly #revoke
  readonly #list

  constructor(database: DatabaseSync) {
    this.#insert = database.prepare(`INSERT INTO keys (id, name, hash, prefix, created_at)
      VALUES (?, ?, ?, ?, ?) RETURNING ${columns}`)
    this.#active = database.prepare(`SELECT ${columns} FROM keys
      WHERE hash = ? AND revoked_at IS NULL`)
    this.#touch = database.prepare(`UPDATE keys SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
    this.#revoke = database.prepare('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    this.#list = database.prepare(`SELECT ${columns} FROM keys ORDER BY created_at, rowid`)
  }

  create(name: string) {
    const secret = `ts_${randomBytes(32)
      .toString('base64url')}`
    const id = `key_${randomBytes(8)
      .toString('hex')}`
    const prefix = secret.slice(0, shownCharacters)
    const row = this.#insert.get(id, name, hashOf(secret), prefix, new Date()
      .toISOString())
    return { key: keySchema.parse(row), secret }
  }

  authenticate(secret: string): Key | undefined {
    const row = this.#active.get(hashOf(secret))
    if (!row) return undefined
    const key = keySchema.parse(row)
    const now = Date.now()
    const stale = new Date(now - lastUsedPrecisionMs)
      .toISOString()
    this.#touch.run(new Date(now)
      .toISOString(), key.id, stale)
    return key
  }

  revoke(id: string) {
    this.#revoke.run(new Date()
      .toISOString(), id)
  }

  list(): Key[] {
    return z.array(keySchema)
      .parse(this.#list.all())
  }
}

// A plain hash is enough because the secret is 256 random bits.
function hashOf(secret: string) {
  return createHash('sha256')
    .update(secret)
    .digest('hex')
}
