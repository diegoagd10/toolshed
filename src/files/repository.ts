import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq, gt } from 'drizzle-orm'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { StoreError } from '../store/error.js'

export const files = sqliteTable('files', {
  id: text()
    .primaryKey(),
  name: text()
    .notNull(),
  mime: text()
    .notNull(),
  bytes: integer()
    .notNull(),
  expiresAt: integer('expires_at')
    .notNull(),
})

export type StoredFile = typeof files.$inferSelect

const lifetimeMs = 24 * 60 * 60 * 1000

export class FilesRepository {
  readonly #database
  readonly #dir
  readonly #partialDir

  constructor(database: NodeSQLiteDatabase, dataDir: string) {
    this.#database = database
    this.#dir = join(dataDir, 'files')
    this.#partialDir = join(dataDir, 'partial')
    for (const dir of [this.#dir, this.#partialDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
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
      this.#database.insert(files)
        .values(file)
        .run()
      return file
    } catch (error) {
      await rm(partial, { force: true })
      await rm(path, { force: true })
      throw error
    }
  }

  // The path comes from a stored id, never from the caller's text.
  find(id: string) {
    const file = this.#database.select()
      .from(files)
      .where(and(eq(files.id, id), gt(files.expiresAt, Date.now())))
      .get()
    if (!file) throw new StoreError('file_not_found', 'the file does not exist or has expired')
    return { file, path: join(this.#dir, file.id) }
  }
}
