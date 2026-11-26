import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { PDFDocument, StandardFonts } from 'pdf-lib'

type FileAnswer = { file_id: string, name: string, pages?: number, download_url: string }

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-mcp-live-'))
const data = join(dir, 'data')

const server = spawn(process.execPath, ['--max-semi-space-size=1', join(dist, 'main.js')], {
  env: {
    ...process.env,
    OWNER_PASSWORD: 'owner',
    PUBLIC_URL: 'http://localhost:0',
    ADMIN_URL: 'http://admin.lan',
    DATA: data,
    AGENT_PORT: '0',
    ADMIN_PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
process.on('exit', () => {
  server.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})
const [line = ''] = await once(createInterface({ input: server.stdout }), 'line') as string[]
const port = Number(/agents on port (\d+)/.exec(line)?.[1])
const endpoint = `http://localhost:${port}/mcp`

const created = execFileSync(process.execPath, [join(dist, 'store.js'), data], {
  input: `${JSON.stringify({ do: 'key.create', name: 'live check' })}\n`,
  encoding: 'utf8',
})
const key = (JSON.parse(created) as { result: { secret: string } }).result.secret

// Links name PUBLIC_URL, port 0 here. The script sends them to the real port.
function local(url: string) {
  return url.replace('http://localhost:0', `http://localhost:${port}`)
}

function curl(...args: string[]) {
  return execFileSync('curl', ['--silent', '--show-error', ...args], { encoding: 'utf8' })
}

async function textPdf(name: string, labels: string[]) {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const label of labels) {
    document.addPage([200, 200])
      .drawText(label, { x: 50, y: 100, font })
  }
  const path = join(dir, name)
  writeFileSync(path, await document.save())
  return path
}

async function call(client: Client, name: string, input: object) {
  const args = Object.fromEntries(Object.entries(input))
  const answer = await client.callTool({ name, arguments: args })
  const [first] = answer.content as { text: string }[]
  assert.ok(!answer.isError, first?.text)
  return JSON.parse(String(first?.text)) as { files: FileAnswer[], command: string }
}

async function flow(version: string) {
  const options = version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {}
  const client = new Client({ name: 'live check', version: '1.0.0' }, options)
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }))
  assert.equal(client.getNegotiatedProtocolVersion(), version)
  const upload = async (path: string, name: string) => {
    const { command } = await call(client, 'file_upload', { name })
    const url = local(/'(.+)'$/.exec(command)?.[1] ?? '')
    return JSON.parse(curl('--fail-with-body', '-T', path, url)) as FileAnswer
  }
  const a = await upload(await textPdf('a.pdf', ['A1', 'A2']), 'a.pdf')
  const b = await upload(await textPdf('b.pdf', ['B1', 'B2', 'B3']), 'b.pdf')
  const [merged] = (await call(client, 'pdf_merge', { files: [a.file_id, b.file_id] })).files
  const { files: parts } = await call(client, 'pdf_split', { file: merged?.file_id, ranges: ['1-2', '3-5'] })
  const texts = parts.map(({ name, download_url: url }) => {
    const path = join(dir, `${version}-${name}`)
    curl('--fail', '-o', path, local(url))
    return execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' })
      .split(/\s+/)
      .filter(Boolean)
      .join(',')
  })
  assert.deepEqual(texts, ['A1,A2', 'B1,B2,B3'])
  assert.deepEqual([merged?.pages, ...parts.map(({ pages }) => pages)], [5, 2, 3])
  console.log(`ok ${version}: file_upload + curl, pdf_merge (5 pages), pdf_split (2 and 3 pages), curl download; pdftotext reads A1,A2 and B1,B2,B3`)
  await client.close()
}

function noVersionHeader() {
  const output = curl(...[
    ['-i', '-X', 'POST', endpoint],
    ['-H', `Authorization: Bearer ${key}`],
    ['-H', 'Content-Type: application/json'],
    ['-H', 'Accept: application/json, text/event-stream'],
    ['-d', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
  ].flat())
  const status = output.split('\r\n')[0]
  assert.equal(status, 'HTTP/1.1 200 OK')
  const tools = JSON.parse(/^data: (.+)$/m.exec(output)?.[1] ?? '') as { result: { tools: object[] } }
  console.log(`ok tools/list without MCP-Protocol-Version or initialize: ${status}`)
  for (const tool of tools.result.tools) {
    const size = JSON.stringify(tool).length
    console.log(`   ${(tool as { name: string }).name}: ${size} characters`)
    assert.ok(size <= 600)
  }
  console.log('ok every tool takes 600 characters or less')
}

await flow('2025-11-25')
await flow('2026-07-28')
noVersionHeader()
server.kill('SIGTERM')
await once(server, 'exit')
