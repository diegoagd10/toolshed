import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { StoreError } from './error.js'

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  bytes: z.int(),
  expiresAt: z.int(),
})

export type StoredFile = z.output<typeof fileSchema>

const lifetimeMs = 24 * 60 * 60 * 1000

export class Files {
  readonly #dir
  readonly #partialDir
  readonly #insert
  readonly #find

  constructor(database: DatabaseSync, dataDir: string) {
    this.#dir = join(dataDir, 'files')
    this.#partialDir = join(dataDir, 'partial')
    for (const dir of [this.#dir, this.#partialDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    this.#insert = database.prepare(`INSERT INTO files (id, name, mime, bytes, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
    this.#find = database.prepare(`SELECT id, name, mime, bytes, expires_at AS expiresAt
      FROM files WHERE id = ? AND expires_at > ?`)
  }

  async save(name: string, mime: string, content: Readable): Promise<StoredFile> {
    const id = `file_${randomBytes(16)
      .toString('base64url')}`
    const partial = join(this.#partialDir, id)
    const path = join(this.#dir, id)
    try {
      const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 })
      await pipeline(content, output)
      await rename(partial, path)
      const expiresAt = Date.now() + lifetimeMs
      const file = { id, name, mime, bytes: output.bytesWritten, expiresAt }
      this.#insert.run(file.id, file.name, file.mime, file.bytes, file.expiresAt)
      return file
    } catch (error) {
      await rm(partial, { force: true })
      await rm(path, { force: true })
      throw error
    }
  }

  // The path comes from a stored id, never from the caller's text.
  find(id: string) {
    const row = this.#find.get(id, Date.now())
    if (!row) throw new StoreError('file_not_found', 'the file does not exist or has expired')
    const file = fileSchema.parse(row)
    return { file, path: join(this.#dir, file.id) }
  }
}
