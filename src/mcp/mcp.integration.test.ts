import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { text } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, onTestFinished, test } from 'vite-plus/test'
import type { Call } from '../calls/repository.js'
import type { Command } from '../store/main.js'

type FileAnswer = {
  file_id: string
  name: string
  mime: string
  pages?: number
  download_url: string
}
type Content = { type: string, text?: string, uri?: string, name?: string, mimeType?: string }
type Answer = { isError?: boolean, content: Content[] }

const dist = join(import.meta.dirname, '../../dist')
const publicUrl = 'https://tools.example.com'
let data = ''
let port = 0
let key = ''
let stopServer: () => Promise<void> = async () => undefined

async function store(...commands: Command[]) {
  const child = spawn(process.execPath, [join(dist, 'store.js'), data])
  child.stdin.end(commands.map((command) => `${JSON.stringify(command)}\n`)
    .join(''))
  const lines = (await text(child.stdout)).trimEnd()
    .split('\n')
  return lines.map((line) => (JSON.parse(line) as { result: unknown }).result)
}

// The same DATA for every server, so they share keys and files.
async function startServer() {
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
  const [line = ''] = await once(createInterface({ input: child.stdout }), 'line') as string[]
  const exited = once(child, 'exit')
  // SIGTERM lets the server close and write its coverage.
  const stop = async () => {
    child.kill('SIGTERM')
    await exited
  }
  return { port: Number(/agents on port (\d+)/.exec(line)?.[1]), stop }
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'toolshed-mcp-'))
  const server = await startServer()
  port = server.port
  stopServer = server.stop
  const [created] = await store({ do: 'key.create', name: 'mcp agent' })
  key = (created as { secret: string }).secret
})

afterAll(async () => {
  await stopServer()
  await rm(data, { recursive: true, force: true })
})

async function connect(version?: string, at = port) {
  const options = version ? { versionNegotiation: { mode: { pin: version } } } : {}
  const client = new Client({ name: 'toolshed test', version: '1.0.0' }, options)
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${at}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  })
  await client.connect(transport)
  onTestFinished(() => client.close())
  return client
}

function rpc(body: unknown, headers: { Authorization?: string } = {}) {
  return fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

// Links carry PUBLIC_URL. The test reaches the same path on the local port.
function local(url: string) {
  const { pathname, search, origin } = new URL(url)
  assert.equal(origin, publicUrl)
  return `http://localhost:${port}${pathname}${search}`
}

async function call(client: Client, name: string, input: object) {
  const args = Object.fromEntries(Object.entries(input))
  const answer = (await client.callTool({ name, arguments: args })) as Answer
  const [first] = answer.content
  return { answer, body: JSON.parse(String(first?.text)) as unknown }
}

async function files(client: Client, name: string, input: object) {
  const { answer, body } = await call(client, name, input)
  assert.ok(!answer.isError, JSON.stringify(body))
  const listed = (body as { files: FileAnswer[] }).files
  // Each file also comes as a resource link, for clients that show or fetch them.
  assert.deepEqual(answer.content.slice(1), listed.map((file) => ({
    type: 'resource_link',
    uri: file.download_url,
    name: file.name,
    mimeType: file.mime,
  })))
  return listed
}

async function upload(client: Client, name: string, content: Uint8Array) {
  const { body } = await call(client, 'file_upload', { name })
  const { upload_url: url, command } = body as { upload_url: string, command: string }
  assert.equal(command, `curl --silent --show-error --fail-with-body -T <path> '${url}'`)
  const response = await fetch(local(url), { method: 'PUT', body: Buffer.from(content) })
  assert.equal(response.status, 200)
  return (await response.json()) as FileAnswer
}

async function pdf(pages: number) {
  const document = await PDFDocument.create()
  for (let page = 0; page < pages; page++) document.addPage([100 + page, 100])
  return document.save()
}

async function widths(file: FileAnswer | undefined) {
  const response = await fetch(local(String(file?.download_url)))
  const document = await PDFDocument.load(await response.arrayBuffer())
  return document.getPages()
    .map((page) => page.getWidth())
}

test('without a key, /mcp gives 401 with WWW-Authenticate: Bearer', async () => {
  const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer nope' })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'unauthorized')
})

test('tools/list without MCP-Protocol-Version gives 200 and every tool', async () => {
  const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(response.status, 200)
  const names = [...(await response.text()).matchAll(/"name":"(\w+)"/g)].map((match) => match[1])
  assert.deepEqual(names, ['qr_create', 'pdf_merge', 'pdf_split', 'file_upload'])
})

test('each tool in tools/list takes 600 characters or less, and defaults are optional', async () => {
  const { tools } = await (await connect()).listTools()
  for (const tool of tools) {
    const size = JSON.stringify(tool).length
    assert.ok(size <= 600, `${tool.name} takes ${size} characters`)
  }
  const qr = tools.find(({ name }) => name === 'qr_create')
  assert.deepEqual(qr?.inputSchema.required, ['text'])
})

for (const version of ['2025-11-25', '2026-07-28']) {
  test(`over ${version}: upload two PDFs, merge, split and download, with pages`, async () => {
    const client = await connect(version === '2026-07-28' ? version : undefined)
    assert.equal(client.getNegotiatedProtocolVersion(), version)
    const a = await upload(client, 'a.pdf', await pdf(2))
    const b = await upload(client, 'b.pdf', await pdf(1))
    const [merged] = await files(client, 'pdf_merge', { files: [a.file_id, b.file_id] })
    assert.deepEqual([merged?.name, merged?.pages], ['merged.pdf', 3])
    assert.deepEqual(await widths(merged), [100, 101, 100])
    const parts = await files(client, 'pdf_split', { file: merged?.file_id, ranges: ['1-2', '3'] })
    assert.deepEqual(parts.map(({ name, pages }) => [name, pages]), [['pages-1-2.pdf', 2], ['pages-3.pdf', 1]])
    assert.deepEqual(await widths(parts[1]), [100])
    const [qr] = await files(client, 'qr_create', { text: 'hello' })
    assert.deepEqual([qr?.name, qr?.pages], ['qr.png', undefined])
  })
}

test('a tool error comes back with isError and its code', async () => {
  const client = await connect()
  const text = await upload(client, 'notes.pdf', Buffer.from('not a pdf'))
  const { answer, body } = await call(client, 'pdf_split', { file: text.file_id, ranges: ['1'] })
  assert.equal(answer.isError, true)
  assert.equal((body as { error: { code: string } }).error.code, 'not_a_pdf')
  const range = await upload(client, 'one.pdf', await pdf(1))
  const outside = await call(client, 'pdf_split', { file: range.file_id, ranges: ['2'] })
  assert.deepEqual(outside.body, { error: { code: 'bad_range', message: 'range 2 is not within pages 1-1' } })
})

test('an internal error shows no detail, and every MCP call is recorded as mcp', async () => {
  const client = await connect()
  await chmod(join(data, 'partial'), 0o500)
  try {
    const { answer, body } = await call(client, 'qr_create', { text: 'hello' })
    assert.equal(answer.isError, true)
    assert.deepEqual(body, { error: { code: 'internal', message: 'internal error' } })
  } finally {
    await chmod(join(data, 'partial'), 0o700)
  }
  const [recent] = await store({ do: 'call.list', limit: 1 })
  assert.deepEqual((recent as Call[]).map(({ tool, via, error }) => ({ tool, via, error })), [
    { tool: 'qr.create', via: 'mcp', error: 'internal' },
  ])
})

// A kept-alive socket would hold the process for up to 5 s after SIGTERM.
test('SIGTERM stops the server in under 2 s with a listen stream open', { timeout: 15_000 }, async () => {
  const server = await startServer()
  const client = await connect('2026-07-28', server.port)
  await client.listen({ toolsListChanged: true })
  const stopped = server.stop()
  assert.equal(await Promise.race([stopped.then(() => 'stopped'), sleep(2_000)
    .then(() => 'still running')]), 'stopped')
})
