import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { text } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, test } from 'vite-plus/test'
import type { Call } from '../calls/repository.js'
import type { Command } from '../store/main.js'

type ErrorAnswer = { error: { code: string, message: string } }
type Server = { port: number, stop: () => Promise<void> }

const dist = join(import.meta.dirname, '../../dist')
const publicUrl = 'https://tools.example.com'
const kilobyte = 1024
let data = ''
let server: Server
let key = ''

// MAX_DISK_MB is 1, so a few uploads fill the disk.
async function startServer(): Promise<Server> {
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    env: {
      ...process.env,
      OWNER_PASSWORD: 'owner',
      PUBLIC_URL: publicUrl,
      ADMIN_URL: 'http://admin.lan',
      DATA: data,
      AGENT_PORT: '0',
      ADMIN_PORT: '0',
      MAX_DISK_MB: '1',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const [line = ''] = await once(createInterface({ input: child.stdout }), 'line') as string[]
  const exited = once(child, 'exit')
  // SIGTERM lets the server close and write its coverage.
  const stop = async () => {
    child.kill('SIGTERM')
    await exited
  }
  return { port: Number(/agents on port (\d+)/.exec(line)?.[1]), stop }
}

async function store(command: Command) {
  const child = spawn(process.execPath, [join(dist, 'store.js'), data])
  child.stdin.end(`${JSON.stringify(command)}\n`)
  return (JSON.parse(await text(child.stdout)) as { result: unknown }).result
}

async function createKey() {
  return ((await store({ do: 'key.create', name: 'limits agent' })) as { secret: string }).secret
}

function database() {
  return new DatabaseSync(join(data, 'toolshed.db'), { timeout: 5000 })
}

function rows() {
  const opened = database()
  const count = Number(opened.prepare('SELECT count(*) AS n FROM files')
    .get()?.n)
  opened.close()
  return count
}

function expireEveryFile() {
  const opened = database()
  opened.exec(`UPDATE files SET expires_at = ${Date.now()}`)
  opened.close()
}

function post(path: string, body: unknown, secret = key) {
  return fetch(`http://localhost:${server.port}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Links carry PUBLIC_URL. The test reaches the same path on the local port.
async function uploadUrl(name: string) {
  const response = await post('/v1/uploads', { name })
  const { upload_url: url } = (await response.json()) as { upload_url: string }
  const { pathname, search } = new URL(url)
  return `http://localhost:${server.port}${pathname}${search}`
}

async function upload(bytes: number) {
  return fetch(await uploadUrl('data.bin'), { method: 'PUT', body: Buffer.alloc(bytes, 'x') })
}

async function failure(response: Response, status: number, code: string) {
  const body = (await response.json()) as ErrorAnswer
  assert.equal(response.status, status, JSON.stringify(body))
  assert.equal(body.error.code, code)
  return body.error.message
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'toolshed-limits-'))
  server = await startServer()
  key = await createKey()
})

afterAll(async () => {
  await server.stop()
  await rm(data, { recursive: true, force: true })
})

test('the 61st tool call of a key in a minute gives 429 with Retry-After, is not recorded, and another key goes on', async () => {
  const secret = await createKey()
  for (let call = 0; call < 60; call++) {
    await failure(await post('/v1/call/pdf.rotate', {}, secret), 404, 'tool_not_found')
  }
  const refused = await post('/v1/call/qr.create', { text: 'one too many' }, secret)
  const wait = Number(refused.headers.get('retry-after'))
  assert.ok(wait >= 1 && wait <= 60, String(wait))
  const message = await failure(refused, 429, 'rate_limited')
  assert.equal(message, `a key can make 60 tool calls a minute; try again in ${wait} s`)
  const [last] = (await store({ do: 'call.list', limit: 1 })) as Call[]
  assert.equal(last?.tool, 'pdf.rotate')
  await failure(await post('/v1/call/pdf.rotate', {}, await createKey()), 404, 'tool_not_found')
})

async function exhaust(secret: string) {
  for (let call = 0; call < 60; call++) await post('/v1/call/pdf.rotate', {}, secret)
  const refused = await post('/v1/call/pdf.rotate', {}, secret)
  assert.equal(refused.status, 429)
  return Number(refused.headers.get('retry-after'))
}

// The calls of the test before are a minute old by the end, so the server also forgets that key.
test('after the seconds in Retry-After the key can call again', { timeout: 90_000 }, async () => {
  const secret = await createKey()
  const wait = await exhaust(secret)
  await sleep(wait * 1000)
  await failure(await post('/v1/call/pdf.rotate', {}, secret), 404, 'tool_not_found')
})

test('an upload declared larger than the room left gives 507 before its body is sent', async () => {
  assert.equal((await upload(700 * kilobyte)).status, 200)
  const sent = request(await uploadUrl('big.bin'), {
    method: 'PUT',
    headers: { 'Content-Length': String(400 * kilobyte) },
  })
  sent.flushHeaders()
  const [response] = await once(sent, 'response') as [import('node:http').IncomingMessage]
  sent.destroy()
  assert.equal(response.statusCode, 507)
  assert.equal(response.headers.connection, 'close')
  const body = JSON.parse(await text(response)) as ErrorAnswer
  assert.equal(body.error.code, 'disk_full')
  assert.match(body.error.message, /^the server keeps up to 1 MB of files and is full; /)
  assert.equal(rows(), 1)
})

test('an upload without a length that passes the room left is stopped and leaves nothing', async () => {
  const chunks = [Buffer.alloc(200 * kilobyte), Buffer.alloc(200 * kilobyte)]
  const response = await fetch(await uploadUrl('stream.bin'), {
    method: 'PUT',
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    }),
    duplex: 'half',
  } as RequestInit)
  await failure(response, 507, 'disk_full')
  assert.deepEqual(await readdir(join(data, 'partial')), [])
  assert.equal(rows(), 1)
})

test('a result that does not fit gives 507 disk_full, and the call is recorded with it', async () => {
  // About 1 KB is left, less than a QR code.
  assert.equal((await upload(1024 * kilobyte - 700 * kilobyte - 1000)).status, 200)
  await failure(await post('/v1/call/qr.create', { text: 'no room' }), 507, 'disk_full')
  const [last] = (await store({ do: 'call.list', limit: 1 })) as Call[]
  assert.deepEqual([last?.tool, last?.error], ['qr.create', 'disk_full'])
  assert.deepEqual(await readdir(join(data, 'work')), [])
})

test('once files expire, the next upload makes room by deleting them', async () => {
  expireEveryFile()
  assert.equal((await upload(900 * kilobyte)).status, 200)
  assert.equal(rows(), 1)
  assert.equal((await readdir(join(data, 'files'))).length, 1)
})

// The leftovers appear while the server is down, as after a crash.
test('a restart deletes expired files and what a crash left in the work folders', async () => {
  await server.stop()
  const hourAgo = new Date(Date.now() - 61 * 60 * 1000)
  const leftovers = [join(data, 'partial', 'file_cut'), join(data, 'work', 'job.job.json'), join(data, 'files', 'file_orphan')]
  for (const path of leftovers) {
    await writeFile(path, 'x')
    await utimes(path, hourAgo, hourAgo)
  }
  await mkdir(join(data, 'work', 'job.partial'))
  await utimes(join(data, 'work', 'job.partial'), hourAgo, hourAgo)
  const young = join(data, 'partial', 'file_arriving')
  await writeFile(young, 'x')
  expireEveryFile()
  server = await startServer()
  assert.equal(rows(), 0)
  assert.deepEqual(await readdir(join(data, 'files')), [])
  assert.deepEqual(await readdir(join(data, 'work')), [])
  assert.deepEqual(await readdir(join(data, 'partial')), ['file_arriving'], 'an upload may still be writing it')
  assert.equal((await upload(1000 * kilobyte)).status, 200)
})
