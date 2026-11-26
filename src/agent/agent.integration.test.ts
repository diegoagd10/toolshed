import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { text } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, test } from 'vite-plus/test'
import type { Call } from '../calls/repository.js'
import type { Command } from '../store/main.js'

type FileAnswer = {
  file_id: string
  name: string
  mime: string
  bytes: number
  expires_at: string
  download_url: string
}
type ErrorAnswer = { error: { code: string, message: string } }
type UploadAnswer = { upload_url: string, method: string, command: string }
type Listed = { id: string, input: { type: string }, example: object }
type Me = { id: string, name: string, prefix: string, created_at: string }
type Headers = { 'Content-Length'?: string }

const toolIds = ['qr.create', 'pdf.merge', 'pdf.split']

const dist = join(import.meta.dirname, '../../dist')
const publicUrl = 'https://tools.example.com'
let data = ''
let agentPort = 0
let adminPort = 0
let serverPid: number | undefined
let stopServer: () => Promise<void> = async () => undefined
let key = ''

async function store(...commands: Command[]) {
  const child = spawn(process.execPath, [join(dist, 'store.js'), data])
  child.stdin.end(commands.map((command) => `${JSON.stringify(command)}\n`)
    .join(''))
  const lines = (await text(child.stdout)).trimEnd()
    .split('\n')
  return lines.map((line) => (JSON.parse(line) as { result: unknown }).result)
}

async function createKey() {
  const [created] = await store({ do: 'key.create', name: 'test agent' })
  return created as { key: { id: string }, secret: string }
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'toolshed-agent-'))
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    env: {
      ...process.env,
      OWNER_PASSWORD: 'owner',
      PUBLIC_URL: publicUrl,
      ADMIN_URL: 'http://admin.lan',
      DATA: data,
      AGENT_PORT: '0',
      ADMIN_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  serverPid = child.pid
  const [line = ''] = await once(createInterface({ input: child.stdout }), 'line') as string[]
  const [, agent, admin] = /agents on port (\d+), admin on port (\d+)/.exec(line) ?? []
  agentPort = Number(agent)
  adminPort = Number(admin)
  const exited = once(child, 'exit')
  // SIGTERM lets the server close and write its coverage.
  stopServer = async () => {
    child.kill('SIGTERM')
    await exited
  }
  key = (await createKey()).secret
})

afterAll(async () => {
  await stopServer()
  await rm(data, { recursive: true, force: true })
})

function api(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key: given = key, ...rest } = init
  const headers = new globalThis.Headers(rest.headers)
  if (given !== null) headers.set('Authorization', `Bearer ${given}`)
  return fetch(`http://localhost:${agentPort}${path}`, { ...rest, headers })
}

function post(path: string, body: unknown, given: string | null = key) {
  return api(path, {
    method: 'POST',
    key: given,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Links carry PUBLIC_URL. The test reaches the same path on the local port.
function local(url: string) {
  const { pathname, search, origin } = new URL(url)
  assert.equal(origin, publicUrl)
  return `http://localhost:${agentPort}${pathname}${search}`
}

async function failure(response: Response, status: number, code: string) {
  const body = (await response.json()) as ErrorAnswer
  assert.equal(response.status, status, JSON.stringify(body))
  assert.equal(body.error.code, code)
  return body.error.message
}

async function upload(name: string, content: Uint8Array | string) {
  const started = await post('/v1/uploads', { name })
  assert.equal(started.status, 200)
  const { upload_url: url, method, command } = (await started.json()) as UploadAnswer
  assert.equal(method, 'PUT')
  assert.equal(command, `curl --silent --show-error --fail-with-body -T <path> '${url}'`)
  const response = await fetch(local(url), { method: 'PUT', body: Buffer.from(content) })
  assert.equal(response.status, 200)
  return (await response.json()) as FileAnswer
}

async function call(tool: string, input: unknown) {
  const response = await post(`/v1/call/${tool}`, input)
  const body = (await response.json()) as { files: FileAnswer[] }
  assert.equal(response.status, 200, JSON.stringify(body))
  return body.files
}

async function pdf(pages: number) {
  const document = await PDFDocument.create()
  for (let page = 0; page < pages; page++) document.addPage([100 + page, 100])
  return document.save()
}

async function widths(file: FileAnswer | undefined) {
  const response = await fetch(local(file?.download_url ?? ''))
  assert.equal(response.status, 200)
  const document = await PDFDocument.load(await response.arrayBuffer())
  return document.getPages()
    .map((page) => page.getWidth())
}

function storedPath(id: string) {
  return join(data, 'files', id)
}

function childrenOfServer() {
  return readFileSync(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')
    .split(' ')
    .filter(Boolean)
}

function rawPut(url: string, headers: Headers) {
  const target = new URL(local(url))
  const sent = request(target, { method: 'PUT', headers })
  sent.on('error', () => undefined)
  const answered = once(sent, 'response')
    .then(([response]) => response as { statusCode: number, resume: () => void })
  // Tests that cut the request never read the answer.
  answered.catch(() => undefined)
  return { sent, answered }
}

async function uploadUrl(name: string) {
  const response = await post('/v1/uploads', { name })
  return ((await response.json()) as { upload_url: string }).upload_url
}

test('health answers on both ports, and other paths give 404 as JSON', async () => {
  for (const port of [agentPort, adminPort]) {
    const response = await fetch(`http://localhost:${port}/health`)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(response.headers.get('x-powered-by'), null)
  }
  for (const path of ['/', '/keys', '/v1', '/health/x']) {
    await failure(await api(path), 404, 'not_found')
  }
})

test('llms.txt lists every tool of /v1/tools and no other', async () => {
  const response = await fetch(`http://localhost:${agentPort}/llms.txt`)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  const body = await response.text()
  const listed = body.split('## Tools')[1]
    ?.trim()
    .split('\n')
    .map((line) => /^- ([\w.]+): /.exec(line)?.[1])
  assert.deepEqual(listed, toolIds)
  assert.match(body, /GET https:\/\/tools\.example\.com\/v1\/me/)
})

test('/v1/tools gives each tool with a JSON Schema and an example, without a key', async () => {
  const response = await api('/v1/tools', { key: null })
  const tools = (await response.json()) as Listed[]
  assert.deepEqual(tools.map(({ id }) => id), toolIds)
  for (const tool of tools) assert.equal(tool.input.type, 'object')
})

test('a missing, malformed, unknown or revoked key gives 401', async () => {
  const revoked = await createKey()
  assert.equal((await api('/v1/me', { key: revoked.secret })).status, 200)
  await store({ do: 'key.revoke', id: revoked.key.id })
  const attempts = [
    api('/v1/me', { key: null }),
    api('/v1/me', { key: null, headers: { Authorization: `Basic ${key}` } }),
    api('/v1/me', { key: `${key}x` }),
    api('/v1/me', { key: revoked.secret }),
    post('/v1/call/qr.create', { text: 'hi' }, null),
    post('/v1/uploads', { name: 'a.pdf' }, null),
  ]
  for (const response of await Promise.all(attempts)) {
    assert.equal(response.headers.get('www-authenticate'), 'Bearer')
    assert.match(await failure(response, 401, 'unauthorized'), /tools\.example\.com\/llms\.txt/)
  }
})

test('/v1/me names the key without its secret', async () => {
  const response = await api('/v1/me')
  const me = (await response.json()) as Me
  assert.equal(me.name, 'test agent')
  assert.equal(me.prefix, key.slice(0, 9))
  assert.ok(!JSON.stringify(me)
    .includes(key))
})

test('upload two PDFs, merge them, split the result and download the parts', async () => {
  const a = await upload('a.pdf', await pdf(2))
  const b = await upload('b.pdf', await pdf(1))
  assert.deepEqual([a.name, a.mime], ['a.pdf', 'application/octet-stream'])
  const [merged] = await call('pdf.merge', { files: [a.file_id, b.file_id] })
  assert.deepEqual(await widths(merged), [100, 101, 100])
  const parts = await call('pdf.split', { file: merged?.file_id, ranges: ['1-2', '3'] })
  assert.deepEqual(parts.map(({ name }) => name), ['pages-1-2.pdf', 'pages-3.pdf'])
  assert.deepEqual(await widths(parts[0]), [100, 101])
  assert.deepEqual(await widths(parts[1]), [100])
  assert.deepEqual(readdirSync(join(data, 'work')), [])
})

test('downloads are attachments that the browser must not sniff, SVG included', async () => {
  const [svg] = await call('qr.create', { text: 'hello', format: 'svg' })
  const response = await fetch(local(svg?.download_url ?? ''))
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename=qr.svg')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.match(await response.text(), /^<svg/)
})

test('a file name with accents downloads under that name', async () => {
  const file = await upload('reporte año.pdf', await pdf(1))
  const response = await fetch(local(file.download_url))
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="reporte a?o.pdf"; filename*=UTF-8\'\'reporte%20a%C3%B1o.pdf',
  )
})

test('invalid input gives 422 and names the field', async () => {
  const merge = await post('/v1/call/pdf.merge', { files: ['file_a'] })
  assert.match(await failure(merge, 422, 'invalid_input'), /^files /)
  const split = await post('/v1/call/pdf.split', { file: 'file_a', ranges: ['1'], extra: 1 })
  assert.match(await failure(split, 422, 'invalid_input'), /extra/)
  const names = ['', 'a/b.pdf', 'a\\b.pdf', 'a\nb.pdf', 'x'.repeat(201)]
  for (const name of names) {
    assert.match(await failure(await post('/v1/uploads', { name }), 422, 'invalid_input'), /^name /)
  }
  await failure(await post('/v1/uploads', {}), 422, 'invalid_input')
})

test('a body that is not JSON gives 400', async () => {
  const response = await api('/v1/call/qr.create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"text":',
  })
  await failure(response, 400, 'bad_request')
})

test('an unknown tool gives 404, and so does an unknown file', async () => {
  assert.match(await failure(await post('/v1/call/pdf.rotate', {}), 404, 'tool_not_found'), /pdf\.rotate/)
  const missing = await post('/v1/call/pdf.merge', { files: ['file_nope', 'file_nada'] })
  await failure(missing, 404, 'file_not_found')
})

test('a file that is not a PDF gives 422 not_a_pdf', async () => {
  const file = await upload('notes.txt', 'just text')
  await failure(await post('/v1/call/pdf.split', { file: file.file_id, ranges: ['1'] }), 422, 'not_a_pdf')
})

test('a tool process that dies gives 500 crashed', async () => {
  const file = await upload('a.pdf', await pdf(1))
  await rm(storedPath(file.file_id))
  await mkdir(storedPath(file.file_id))
  const response = await post('/v1/call/pdf.split', { file: file.file_id, ranges: ['1'] })
  assert.equal(await failure(response, 500, 'crashed'), 'the job stopped before it finished')
})

test('an internal error gives 500 without its message, and the call is recorded', async () => {
  await chmod(join(data, 'partial'), 0o500)
  try {
    const response = await post('/v1/call/qr.create', { text: 'hello' })
    assert.equal(await failure(response, 500, 'internal'), 'internal error')
  } finally {
    await chmod(join(data, 'partial'), 0o700)
  }
  const [recent] = await store({ do: 'call.list', limit: 1 })
  assert.deepEqual((recent as Call[]).map(({ tool, via, error }) => ({ tool, via, error })), [
    { tool: 'qr.create', via: 'rest', error: 'internal' },
  ])
})

test('each call is recorded with its key, tool and error', async () => {
  const { key: { id } } = await createKey()
  await call('qr.create', { text: 'recorded' })
  await post('/v1/call/pdf.rotate', {})
  const [recent] = await store({ do: 'call.list', limit: 2 })
  assert.deepEqual((recent as Call[]).map(({ tool, error }) => [tool, error]), [
    ['pdf.rotate', 'tool_not_found'],
    ['qr.create', null],
  ])
  assert.ok((recent as Call[]).every(({ keyId }) => keyId !== id))
})

test('a link that is altered, for another method or for a missing file is refused', async () => {
  const file = await upload('a.pdf', await pdf(1))
  const url = new URL(local(file.download_url))
  const signature = url.searchParams.get('signature') ?? ''
  // The last character of a base64url HMAC can already be A, so change the first one.
  url.searchParams.set('signature', `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`)
  await failure(await fetch(url), 403, 'bad_signature')
  await failure(await fetch(local(file.download_url), { method: 'PUT', body: 'x' }), 403, 'bad_signature')
  const unsigned = `http://localhost:${agentPort}/f/${file.file_id}`
  await failure(await fetch(unsigned), 403, 'bad_signature')
  const database = new DatabaseSync(join(data, 'toolshed.db'), { timeout: 5000 })
  database.prepare('DELETE FROM files WHERE id = ?')
    .run(file.file_id)
  database.close()
  await failure(await fetch(local(file.download_url)), 404, 'file_not_found')
})

test('an upload declared above 50 MB gives 413 before any byte arrives', async () => {
  const { sent, answered } = rawPut(await uploadUrl('big.pdf'), { 'Content-Length': String(51 * 2 ** 20) })
  sent.flushHeaders()
  const response = await answered
  assert.equal(response.statusCode, 413)
  sent.destroy()
})

// The server stops reading at 50 MB and closes the connection. A client that is still writing may
// see the reset before it reads the 413, so either outcome passes. No file may remain.
test('a chunked upload that passes 50 MB is stopped and leaves no file', async () => {
  const { sent, answered } = rawPut(await uploadUrl('big.pdf'), {})
  const outcome = answered.then(
    (response) => response.statusCode,
    (error: { code: string }) => error.code,
  )
  let settled = false
  void outcome.then(() => {
    settled = true
  })
  const chunk = Buffer.alloc(2 ** 20)
  for (let written = 0; written < 60 && !settled && !sent.destroyed; written++) {
    if (!sent.write(chunk)) await Promise.race([once(sent, 'drain'), outcome])
      .catch(() => undefined)
  }
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(await outcome), String(await outcome))
  sent.destroy()
  const deadline = performance.now() + 5000
  while (readdirSync(join(data, 'partial')).length > 0 && performance.now() < deadline) await sleep(20)
  assert.deepEqual(readdirSync(join(data, 'partial')), [])
})

test('an upload cut in the middle leaves no file', async () => {
  const database = new DatabaseSync(join(data, 'toolshed.db'), { timeout: 5000 })
  const count = () => database.prepare('SELECT count(*) AS n FROM files')
    .get()?.n
  const before = count()
  const { sent } = rawPut(await uploadUrl('cut.pdf'), { 'Content-Length': String(10 * 2 ** 20) })
  sent.write(Buffer.alloc(5 * 2 ** 20))
  const deadline = performance.now() + 5000
  while (readdirSync(join(data, 'partial')).length === 0 && performance.now() < deadline) await sleep(20)
  assert.equal(readdirSync(join(data, 'partial')).length, 1)
  sent.destroy()
  while (readdirSync(join(data, 'partial')).length > 0 && performance.now() < deadline) await sleep(20)
  assert.deepEqual(readdirSync(join(data, 'partial')), [])
  assert.equal(count(), before)
  database.close()
})

// Each stored file becomes a FIFO, so its job waits until the test writes the PDF into it.
test('a 13th job while 12 wait gives 503 busy with Retry-After', { timeout: 30_000 }, async () => {
  const content = await pdf(1)
  const files = await Promise.all(Array.from({ length: 12 }, (_, index) => upload(`${index}.pdf`, content)))
  for (const { file_id: id } of files) {
    await rm(storedPath(id))
    execFileSync('mkfifo', [storedPath(id)])
  }
  const calls = files.map(({ file_id: id }) => post('/v1/call/pdf.split', { file: id, ranges: ['1'] }))
  while (childrenOfServer().length < 2) await sleep(20)
  await sleep(500)
  const busy = await post('/v1/call/qr.create', { text: 'one too many' })
  assert.equal(busy.headers.get('retry-after'), '5')
  await failure(busy, 503, 'busy')
  const waiting = new Set(files.map(({ file_id: id }) => storedPath(id)))
  while (waiting.size > 0) {
    for (const path of waiting) {
      // Opening a FIFO without blocking fails until its job opens it for reading.
      const handle = await open(path, constants.O_WRONLY | constants.O_NONBLOCK)
        .catch(() => undefined)
      if (!handle) continue
      await handle.write(content)
      await handle.close()
      waiting.delete(path)
    }
    await sleep(20)
  }
  for (const response of await Promise.all(calls)) assert.equal(response.status, 200)
})
