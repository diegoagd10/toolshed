import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const secretSchema = z.object({ value: z.instanceof(Uint8Array) })

export type LinkTarget = { method: string, id: string }
export type SignedLink = LinkTarget & { expiresAt: number, signature: string }

export class Links {
  readonly #secret

  constructor(database: DatabaseSync) {
    database.prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES ('links', ?)")
      .run(randomBytes(32))
    const row = database.prepare("SELECT value FROM secrets WHERE name = 'links'")
      .get()
    this.#secret = secretSchema.parse(row).value
  }

  sign({ method, id }: LinkTarget, lifetimeMs: number): SignedLink {
    const expiresAt = Date.now() + lifetimeMs
    return { method, id, expiresAt, signature: this.#signature(method, id, expiresAt) }
  }

  verify({ method, id, expiresAt, signature }: SignedLink) {
    const given = Buffer.from(signature)
    const expected = Buffer.from(this.#signature(method, id, expiresAt))
    return given.length === expected.length &&
      timingSafeEqual(given, expected) &&
      expiresAt > Date.now()
  }

  #signature(method: string, id: string, expiresAt: number) {
    return createHmac('sha256', this.#secret)
      .update(JSON.stringify([method, id, expiresAt]))
      .digest('base64url')
  }
}
