import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq, gt, inArray, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
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
// Jobs stop after 30 s and requests after 5 minutes, so anything older in a work folder is left
// over from a crash.
const staleMs = 60 * 60 * 1000

export class FilesRepository {
  readonly #database
  readonly #dir
  readonly #partialDir
  // Tool jobs write their results here before they are saved.
  readonly workDir
  readonly #maxBytes
  // Bytes of the files in the table, and of the saves still writing.
  #stored = 0
  #writing = 0
  #cleaning: Promise<void> | undefined

  constructor(database: BetterSQLite3Database, dataDir: string, maxBytes: number) {
    this.#database = database
    this.#dir = join(dataDir, 'files')
    this.#partialDir = join(dataDir, 'partial')
    this.workDir = join(dataDir, 'work')
    this.#maxBytes = maxBytes
    for (const dir of [this.#dir, this.#partialDir, this.workDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    this.#stored = this.#total()
  }

  // `declared` is the size when it is known before the first byte, such as a Content-Length.
  async save(name: string, mime: string, content: Readable, declared = 0): Promise<StoredFile> {
    await this.#makeRoom(declared)
    const id = `file_${randomBytes(16)
      .toString('base64url')}`
    const partial = join(this.#partialDir, id)
    const path = join(this.#dir, id)
    const progress = { bytes: 0 }
    try {
      const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 })
      await pipeline(content, (source: Readable) => this.#counted(source, progress), output)
      await rename(partial, path)
      const expiresAt = Date.now() + lifetimeMs
      const file = { id, name, mime, bytes: output.bytesWritten, expiresAt }
      this.#database.insert(files)
        .values(file)
        .run()
      this.#stored += file.bytes
      return file
    } catch (error) {
      await rm(partial, { force: true })
      await rm(path, { force: true })
      throw error
    } finally {
      this.#writing -= progress.bytes
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

  // Deletes expired files, files without a row, rows without a file and old leftovers of jobs and
  // uploads. Each step only deletes, so running it again, or after a crash in the middle, ends in
  // the same state.
  clean() {
    this.#cleaning ??= this.#clean()
      .finally(() => {
        this.#cleaning = undefined
      })
    return this.#cleaning
  }

  async #clean() {
    const now = Date.now()
    // The row goes first, so no request finds a file that is being deleted.
    const expired = this.#database.delete(files)
      .where(lte(files.expiresAt, now))
      .returning({ id: files.id })
      .all()
    for (const { id } of expired) await rm(join(this.#dir, id), { force: true })
    const rows = this.#database.select({ id: files.id })
      .from(files)
      .all()
    const missing = rows.filter(({ id }) => !existsSync(join(this.#dir, id)))
      .map(({ id }) => id)
    this.#database.delete(files)
      .where(inArray(files.id, missing))
      .run()
    // A save renames its file into place just before it inserts the row, so a young file without
    // a row may still get one.
    const known = new Set(rows.map(({ id }) => id))
    await removeStale(this.#dir, now, (name) => !known.has(name))
    await removeStale(this.#partialDir, now)
    await removeStale(this.workDir, now)
    this.#stored = this.#total()
  }

  async #makeRoom(bytes: number) {
    if (this.#fits(bytes)) return
    await this.clean()
    if (!this.#fits(bytes)) throw this.#full()
  }

  async* #counted(source: Readable, progress: { bytes: number }) {
    for await (const chunk of source) {
      const size = (chunk as Buffer).byteLength
      progress.bytes += size
      this.#writing += size
      if (!this.#fits(0)) throw this.#full()
      yield chunk as Buffer
    }
  }

  #fits(bytes: number) {
    return this.#stored + this.#writing + bytes <= this.#maxBytes
  }

  #full() {
    const megabytes = Math.round(this.#maxBytes / 2 ** 20)
    return new StoreError('disk_full', `the server keeps up to ${megabytes} MB of files and is full; files are deleted 24 hours after they are made, so try again later`)
  }

  #total() {
    return this.#database.select({ bytes: files.bytes })
      .from(files)
      .all()
      .reduce((total, { bytes }) => total + bytes, 0)
  }
}

async function removeStale(dir: string, now: number, chosen = (_name: string) => true) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    // An entry can go away between the listing and this look, such as an upload that finished.
    const stats = await stat(path)
      .catch(() => undefined)
    const stale = stats && chosen(name) && stats.mtimeMs < now - staleMs
    if (stale) await rm(path, { recursive: true, force: true })
  }
}
