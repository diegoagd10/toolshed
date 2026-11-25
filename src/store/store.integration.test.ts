import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { text } from 'node:stream/consumers'
import { onTestFinished, test } from 'vite-plus/test'
import type { Call } from '../calls/repository.js'
import type { StoredFile } from '../files/repository.js'
import type { Key } from '../keys/repository.js'
import type { SignedLink } from '../links/links.js'
import type { Command } from './main.js'

type Answer = { result?: unknown, error?: string }
type Created = { key: Key, secret: string }
type Found = { file: StoredFile, path: string }

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'toolshed-store-'))
  onTestFinished(() => rm(dir, { recursive: true }))
  return join(dir, 'data')
}

async function execute(dir: string, lines: string[]) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../../dist/store.js'), dir], {
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(lines.map((line) => `${line}\n`)
    .join(''))
  const [output, errors, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise((resolve) => child.once('close', resolve)),
  ])
  return { output, errors, code }
}

async function answers(dir: string, ...commands: Command[]): Promise<Answer[]> {
  const lines = commands.map((command) => JSON.stringify(command))
  const { output, errors, code } = await execute(dir, lines)
  assert.equal(code, 0, errors)
  return output.trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Answer)
}

async function ask<Result>(dir: string, command: Command) {
  const [answer] = await answers(dir, command)
  assert.equal(answer?.error, undefined)
  return answer?.result as Result
}

async function database(dir: string) {
  const opened = new DatabaseSync(join(dir, 'toolshed.db'))
  onTestFinished(() => opened.close())
  return opened
}

function createKey(dir: string, name = 'Claude Code') {
  return ask<Created>(dir, { do: 'key.create', name })
}

function authenticate(dir: string, secret: string) {
  return ask<Key | null>(dir, { do: 'key.authenticate', secret })
}

test('a created key authenticates, after a restart too', async () => {
  const dir = await dataDir()
  const { key, secret } = await createKey(dir)
  assert.match(secret, /^ts_[\w-]{43}$/)
  assert.equal(key.prefix, secret.slice(0, 9))
  assert.deepEqual([key.name, key.lastUsedAt, key.revokedAt], ['Claude Code', null, null])
  assert.equal((await authenticate(dir, secret))?.id, key.id)
})

test('altered, empty and hashed secrets do not authenticate', async () => {
  const dir = await dataDir()
  const { secret } = await createKey(dir)
  const hash = (await database(dir)).prepare('SELECT hash FROM keys')
    .get()?.hash
  const last = secret.endsWith('A') ? 'B' : 'A'
  for (const wrong of ['', 'ts_', secret.slice(0, -1), `${secret} `, secret.slice(0, -1) + last, secret.toUpperCase(), String(hash)]) {
    assert.equal(await authenticate(dir, wrong), null, wrong)
  }
})

test('a revoked key does not authenticate and others still do', async () => {
  const dir = await dataDir()
  const revoked = await createKey(dir)
  const other = await createKey(dir)
  await answers(dir, { do: 'key.revoke', id: revoked.key.id })
  assert.equal(await authenticate(dir, revoked.secret), null)
  assert.equal((await authenticate(dir, other.secret))?.id, other.key.id)
})

test('revoking twice, or an unknown id, leaves the same state', async () => {
  const dir = await dataDir()
  const { key } = await createKey(dir)
  await answers(dir, { do: 'key.revoke', id: key.id })
  const before = await ask<Key[]>(dir, { do: 'key.list' })
  assert.notEqual(before[0]?.revokedAt, null)
  await answers(dir, { do: 'key.revoke', id: key.id }, { do: 'key.revoke', id: 'key_x' })
  assert.deepEqual(await ask(dir, { do: 'key.list' }), before)
})

test('using a key sets lastUsedAt, and again only after a minute', async () => {
  const dir = await dataDir()
  const { secret } = await createKey(dir)
  const lastUsed = async () => (await ask<Key[]>(dir, { do: 'key.list' }))[0]?.lastUsedAt
  await authenticate(dir, secret)
  const first = await lastUsed()
  assert.ok(first && Math.abs(Date.now() - Date.parse(first)) < 10_000)
  await authenticate(dir, secret)
  assert.equal(await lastUsed(), first)
  const old = '2020-01-01T00:00:00.000Z'
  const opened = await database(dir)
  opened.exec(`UPDATE keys SET last_used_at = '${old}'`)
  await authenticate(dir, `${secret}x`)
  assert.equal(await lastUsed(), old)
  await authenticate(dir, secret)
  assert.notEqual(await lastUsed(), old)
})

test('keys are listed in creation order without hashes or secrets', async () => {
  const dir = await dataDir()
  const keys = [await createKey(dir, 'one'), await createKey(dir, 'two')]
  assert.deepEqual(await ask(dir, { do: 'key.list' }), keys.map(({ key }) => key))
  assert.deepEqual(Object.keys(keys[0]?.key ?? {}), ['id', 'name', 'prefix', 'createdAt', 'lastUsedAt', 'revokedAt'])
})

test('a secret is nowhere on disk', async () => {
  const dir = await dataDir()
  const { secret } = await createKey(dir)
  await authenticate(dir, secret)
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  assert.ok(files.length > 0)
  for (const { parentPath, name } of files) {
    assert.ok(!(await readFile(join(parentPath, name))).includes(secret.slice(3)), name)
  }
})

test('only the owner can read the database, even in a directory open to others', async () => {
  const dir = await dataDir()
  await mkdir(dir, { mode: 0o755 })
  await answers(dir, { do: 'key.list' })
  for (const name of ['toolshed.db', 'migrate.lock']) {
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600)
  }
})

test('calls are listed from the newest', async () => {
  const dir = await dataDir()
  const { key } = await createKey(dir)
  const calls = ['pdf.merge', 'pdf.split', 'qr.create'].map((tool, index): Call => ({
    at: new Date(index)
      .toISOString(),
    keyId: key.id,
    tool,
    via: index === 0 ? 'rest' : 'mcp',
    ms: index,
    error: index === 1 ? 'bad_range' : null,
  }))
  await answers(dir, ...calls.map((call): Command => ({ do: 'call.record', call })))
  assert.deepEqual(await ask(dir, { do: 'call.list', limit: 10 }), calls.toReversed())
  assert.deepEqual(await ask(dir, { do: 'call.list', limit: 1 }), calls.slice(2))
})

test('a call of an unknown key is rejected', async () => {
  const dir = await dataDir()
  const call: Call = { at: '', keyId: 'key_x', tool: 'qr.create', via: 'rest', ms: 1, error: null }
  const [answer] = await answers(dir, { do: 'call.record', call })
  assert.match(answer?.error ?? '', /Failed query: insert into .calls./)
  assert.deepEqual(await ask(dir, { do: 'call.list', limit: 1 }), [])
})

async function saveFile(dir: string, content: string | Uint8Array) {
  const path = join(dir, '..', 'input')
  await writeFile(path, content)
  return ask<StoredFile>(dir, { do: 'file.save', name: 'a "b".pdf', mime: 'application/pdf', path })
}

test('a saved file is found, after a restart too, and only its owner can read it', async () => {
  const dir = await dataDir()
  const content = Buffer.alloc(300_000, 'á')
  const saved = await saveFile(dir, content)
  assert.match(saved.id, /^file_[\w-]{22}$/)
  assert.equal(saved.bytes, content.byteLength)
  assert.ok(Math.abs(saved.expiresAt - Date.now() - 24 * 3600 * 1000) < 10_000)
  const { file, path } = await ask<Found>(dir, { do: 'file.find', id: saved.id })
  assert.deepEqual(file, saved)
  assert.deepEqual([file.name, file.mime], ['a "b".pdf', 'application/pdf'])
  assert.ok(content.equals(await readFile(path)))
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(join(dir, 'partial')), [])
})

test('an expired file is not found', async () => {
  const dir = await dataDir()
  const { id } = await saveFile(dir, 'x')
  const opened = await database(dir)
  opened.exec(`UPDATE files SET expires_at = ${Date.now()}`)
  assert.deepEqual(await answers(dir, { do: 'file.find', id }), [{ error: 'file_not_found' }])
})

for (const id of ['', '..', '../toolshed.db', '/etc/passwd', 'file_x', 'file_x\0', '\0', "' OR 1=1 --"]) {
  test(`${JSON.stringify(id)} is file_not_found`, async () => {
    const dir = await dataDir()
    const { id: real } = await saveFile(dir, 'x')
    assert.deepEqual(
      await answers(dir, { do: 'file.find', id }, { do: 'file.find', id: `${real}${id || '\0'}` }, { do: 'file.find', id: `${id}/../${real}` }),
      [{ error: 'file_not_found' }, { error: 'file_not_found' }, { error: 'file_not_found' }],
    )
  })
}

test('a file that fails to arrive leaves nothing', async () => {
  const dir = await dataDir()
  await answers(dir, { do: 'key.list' })
  const [answer] = await answers(dir, { do: 'file.save', name: 'x', mime: 'x', path: dir })
  assert.match(answer?.error ?? '', /EISDIR/)
  assert.deepEqual(await readdir(join(dir, 'files')), [])
  assert.deepEqual(await readdir(join(dir, 'partial')), [])
})

test('a file that fails to be recorded leaves nothing', async () => {
  const dir = await dataDir()
  await answers(dir, { do: 'key.list' })
  const opened = await database(dir)
  opened.exec("CREATE TRIGGER no BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'no'); END")
  const path = join(dir, '..', 'input')
  await writeFile(path, 'x')
  const [answer] = await answers(dir, { do: 'file.save', name: 'x', mime: 'x', path })
  assert.match(answer?.error ?? '', /Failed query: insert into .files./)
  assert.deepEqual(await readdir(join(dir, 'files')), [])
  assert.deepEqual(await readdir(join(dir, 'partial')), [])
})

test('a signed link is valid, after a restart too', async () => {
  const dir = await dataDir()
  const link = await ask<SignedLink>(dir, { do: 'link.sign', method: 'GET', id: 'file_a', lifetimeMs: 60_000 })
  assert.equal(await ask(dir, { do: 'link.verify', ...link }), true)
})

test('expired and altered links are rejected', async () => {
  const dir = await dataDir()
  const sign = (lifetimeMs: number) => ask<SignedLink>(dir, { do: 'link.sign', method: 'GET', id: 'file_a', lifetimeMs })
  const link = await sign(60_000)
  const expired = await sign(-1)
  const { signature } = link
  const last = signature.endsWith('A') ? 'B' : 'A'
  const wrong: SignedLink[] = [
    expired,
    { ...expired, expiresAt: link.expiresAt },
    { ...link, expiresAt: link.expiresAt + 1 },
    { ...link, id: 'file_b' },
    { ...link, method: 'PUT' },
    { ...link, method: 'get' },
    { ...link, signature: '' },
    { ...link, signature: signature.slice(0, -1) + last },
    { ...link, signature: `${signature}=` },
    { ...link, signature: 'é'.repeat(signature.length) },
  ]
  // The last character holds unused bits, so another spelling can decode to the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  for (const character of alphabet) {
    if (signature.endsWith(character)) continue
    wrong.push({ ...link, signature: signature.slice(0, -1) + character })
  }
  const results = await answers(dir, ...wrong.map((altered): Command => ({ do: 'link.verify', ...altered })))
  assert.deepEqual(results, wrong.map(() => ({ result: false })))
})

test('a link of another installation is rejected', async () => {
  const link = await ask<SignedLink>(await dataDir(), { do: 'link.sign', method: 'GET', id: 'file_a', lifetimeMs: 60_000 })
  assert.equal(await ask(await dataDir(), { do: 'link.verify', ...link }), false)
})

const migrationsDir = join(import.meta.dirname, '../../drizzle')

async function openFirstVersion(dir: string) {
  await mkdir(dir)
  const [first = ''] = (await readdir(migrationsDir)).toSorted()
  const opened = await database(dir)
  opened.exec(await readFile(join(migrationsDir, first, 'migration.sql'), 'utf8'))
  opened.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL,
      created_at numeric, name text, applied_at TEXT);
    INSERT INTO __drizzle_migrations (hash, name) VALUES ('h', '${first}');
    INSERT INTO keys VALUES ('key_1', 'old', 'h', 'ts_abc', '2026-01-01T00:00:00.000Z', NULL, NULL);
    INSERT INTO calls VALUES (7, '2026-01-01T00:00:00.000Z', 'key_1', 'qr.create', 'rest', 5, NULL);`)
  return opened
}

async function dump(dir: string) {
  const opened = await database(dir)
  const tables = ['sqlite_schema', 'keys', 'calls', 'files', 'secrets', '__drizzle_migrations']
  return tables.map((table) => opened.prepare(`SELECT * FROM ${table}`)
    .all())
}

test('a database of the first version migrates without losing rows, and opening it again changes nothing', async () => {
  const dir = await dataDir()
  const opened = await openFirstVersion(dir)
  const [key] = await ask<Key[]>(dir, { do: 'key.list' })
  const [call] = await ask<Call[]>(dir, { do: 'call.list', limit: 9 })
  assert.deepEqual([key?.id, key?.name, call?.keyId, call?.ms], ['key_1', 'old', 'key_1', 5])
  const before = await dump(dir)
  assert.equal(before.at(-1)?.length, 2)
  await answers(dir, { do: 'key.list' })
  assert.deepEqual(await dump(dir), before)
  assert.equal(opened.prepare('PRAGMA foreign_key_check')
    .get(), undefined)
})

test('a migration that fails changes nothing', async () => {
  const dir = await dataDir()
  const opened = await openFirstVersion(dir)
  opened.exec('CREATE TABLE secrets (other TEXT)')
  const { code, errors } = await execute(dir, [])
  assert.equal(code, 1)
  assert.match(errors, /secrets. already exists/)
  const tables = opened.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => name)
  assert.deepEqual(tables, ['__drizzle_migrations', 'calls', 'keys', 'secrets'])
})

test('a database from a newer version is refused and left alone', async () => {
  const dir = await dataDir()
  await answers(dir, { do: 'key.list' })
  const opened = await database(dir)
  opened.exec("INSERT INTO __drizzle_migrations (hash, name) VALUES ('h', '20990101000000_future')")
  const before = await dump(dir)
  const { code, errors } = await execute(dir, [])
  assert.equal(code, 1)
  assert.match(errors, /20990101000000_future/)
  assert.deepEqual(await dump(dir), before)
})

test('two processes that open a new database at once both work', async () => {
  const dir = await dataDir()
  const keys = await Promise.all(['a', 'b', 'c', 'd'].map((name) => createKey(dir, name)))
  assert.equal(new Set(keys.map(({ key }) => key.id)).size, 4)
  assert.equal((await ask<Key[]>(dir, { do: 'key.list' })).length, 4)
})

test('a bad command is answered and the next one works', async () => {
  const dir = await dataDir()
  const { output } = await execute(dir, ['nope', '{"do":"key.drop"}', '{"do":"key.list"}'])
  const lines = output.trimEnd()
    .split('\n')
  assert.match(lines[0] ?? '', /SyntaxError/)
  assert.match(lines[1] ?? '', /do/)
  assert.equal(lines[2], '{"result":[]}')
})
