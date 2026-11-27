// Live checks for the limits. With no argument it runs all three:
//   node scripts/limits.ts disk    MAX_DISK_MB=20: uploads until 507; once they expire, one fits
//   node scripts/limits.ts logs    every flow, then keys, codes and the password looked for in logs
//   node scripts/limits.ts memory  RSS after 1000 QR codes and 100 merges, against after 100 and 10
// The server's output of `logs` goes to $LIMITS_EVIDENCE (default: a temporary folder).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { PDFDocument } from 'pdf-lib'

type Failure = { error?: { code: string, message: string } }
type FileAnswer = { file_id: string, download_url: string, pages?: number }
type Answer = Failure & { files: FileAnswer[], upload_url: string }
type Running = {
  base: string
  admin: string
  pid: number
  output: string[]
  stop: () => Promise<void>
}

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-limits-live-'))
const publicUrl = 'https://tools.example.com'
const adminUrl = 'http://admin.lan'
const password = 'correct horse limits staple'
const [mode = 'all'] = process.argv.slice(2)
const servers: Running[] = []
process.on('exit', () => {
  for (const { pid } of servers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already stopped.
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

// The same flags as npm start. Everything it prints is kept, both streams.
async function startServer(data: string, extra: { MAX_DISK_MB?: string } = {}): Promise<Running> {
  const child = spawn(process.execPath, ['--max-semi-space-size=1', join(dist, 'main.js')], {
    env: {
      ...process.env,
      OWNER_PASSWORD: password,
      PUBLIC_URL: publicUrl,
      ADMIN_URL: adminUrl,
      DATA: data,
      AGENT_PORT: '0',
      ADMIN_PORT: '0',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  createInterface({ input: child.stderr })
    .on('line', (line) => output.push(line))
  const lines = createInterface({ input: child.stdout })
  const [first = ''] = await once(lines, 'line') as string[]
  output.push(first)
  lines.on('line', (line) => output.push(line))
  const [, agent, admin] = /agents on port (\d+), admin on port (\d+)/.exec(first) ?? []
  const exited = once(child, 'exit')
  const running = {
    base: `http://localhost:${agent}`,
    admin: `http://localhost:${admin}`,
    pid: Number(child.pid),
    output,
    stop: async () => {
      child.kill('SIGTERM')
      await exited
    },
  }
  servers.push(running)
  return running
}

function storeKey(data: string, name: string) {
  const output = execFileSync(process.execPath, [join(dist, 'store.js'), data], {
    input: `${JSON.stringify({ do: 'key.create', name })}\n`,
    encoding: 'utf8',
  })
  return (JSON.parse(output) as { result: { secret: string } }).result.secret
}

function curl(...args: string[]) {
  return execFileSync('curl', ['--silent', '--show-error', ...args], { encoding: 'utf8', maxBuffer: 2 ** 26 })
}

function local(server: Running, url: string) {
  return url.replace(publicUrl, server.base)
}

async function api(server: Running, key: string, path: string, body?: unknown) {
  const response = await fetch(`${server.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Answer }
}

// Uploads the way llms.txt tells an agent to: ask for a link, then curl -T.
async function upload(server: Running, key: string, path: string) {
  const { body } = await api(server, key, '/v1/uploads', { name: 'upload.bin' })
  const answer = curl('-w', '\n%{http_code}', '-T', path, local(server, body.upload_url))
  const [json = '', status = ''] = answer.split('\n')
  return { status: Number(status), body: JSON.parse(json) as FileAnswer & Failure }
}

async function pdf(pages: number) {
  const document = await PDFDocument.create()
  for (let page = 0; page < pages; page++) document.addPage([100 + page, 100])
  return document.save()
}

async function disk() {
  const data = join(dir, 'disk')
  const server = await startServer(data, { MAX_DISK_MB: '20' })
  const key = storeKey(data, 'disk check')
  const chunk = join(dir, 'six.bin')
  writeFileSync(chunk, Buffer.alloc(6 * 2 ** 20, 'x'))
  const statuses = []
  for (let attempt = 0; attempt < 4; attempt++) {
    statuses.push((await upload(server, key, chunk)).status)
  }
  assert.deepEqual(statuses, [200, 200, 200, 507])
  const refused = await upload(server, key, chunk)
  assert.equal(refused.body.error?.code, 'disk_full')
  console.log(`ok MAX_DISK_MB=20, four curl uploads of 6 MB: ${statuses.join(', ')}; "${refused.body.error?.message}"`)
  const files = join(data, 'files')
  const used = readdirSync(files).length
  // As 24 hours would: the rows say the files expired. The server finds out by itself.
  const database = new DatabaseSync(join(data, 'toolshed.db'), { timeout: 5000 })
  database.exec(`UPDATE files SET expires_at = ${Date.now()}`)
  database.close()
  const next = await upload(server, key, chunk)
  assert.equal(next.status, 200)
  assert.deepEqual(readdirSync(files), [next.body.file_id])
  console.log(`ok after the ${used} files expire, the next upload gives ${next.status} and the folder holds only it`)
  await server.stop()
}

async function form(server: Running, path: string, fields: string[][], cookie = '') {
  return fetch(`${server.admin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': adminUrl, 'Cookie': cookie },
    body: new URLSearchParams(fields)
      .toString(),
    redirect: 'manual',
  })
}

async function mcp(server: Running, key: string, body: unknown) {
  const response = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
  return response.text()
}

async function logs() {
  const data = join(dir, 'logs')
  const server = await startServer(data, { MAX_DISK_MB: '20' })
  const secrets: string[] = [password]
  const flows: string[] = []

  // The owner: a sign in, then wrong passwords up to the lockout, and a key made on Keys.
  const signed = await form(server, '/login', [['password', password]])
  const session = String(String(signed.headers.get('set-cookie'))
    .split(';')[0])
  const attempts = []
  for (let attempt = 0; attempt < 6; attempt++) {
    attempts.push((await form(server, '/login', [['password', `wrong ${password}`]])).status)
  }
  assert.deepEqual(attempts, [401, 401, 401, 401, 401, 429])
  flows.push('sign in, 5 wrong passwords and a locked out one')
  await form(server, '/keys', [['name', 'dashboard key']], session)
  const keysPage = await (await fetch(`${server.admin}/keys`, { headers: { Cookie: session } })).text()
  const dashboardKey = String(/id="new-key">([^<]+)</.exec(keysPage)?.[1])
  assert.match(dashboardKey, /^ts_/)
  secrets.push(dashboardKey, String(session.split('=')[1]))
  flows.push('a key made on Keys')

  // An agent pairs: a wrong code first, then the right one.
  const started = (await (await fetch(`${server.base}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'log check agent' }),
  })).json()) as { pair_id: string, code: string }
  secrets.push(started.code, started.code.replace('-', ''), started.pair_id)
  await form(server, '/pair/approve', [['code', 'WRON-GCOD']], session)
  await form(server, '/pair/approve', [['code', started.code]], session)
  const token = (await (await fetch(`${server.base}/pair/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair_id: started.pair_id }),
  })).json()) as { key: string }
  const key = token.key
  secrets.push(key)
  flows.push('pairing with a wrong code, then the right one')

  // REST: the tools, uploads, downloads and errors, a key in a broken body included.
  await api(server, key, '/v1/me')
  const pdfPath = join(dir, 'three.pdf')
  writeFileSync(pdfPath, await pdf(3))
  const first = await upload(server, key, pdfPath)
  const second = await upload(server, key, pdfPath)
  const merged = await api(server, key, '/v1/call/pdf.merge', { files: [first.body.file_id, second.body.file_id] })
  const parts = await api(server, key, '/v1/call/pdf.split', { file: merged.body.files[0]?.file_id, ranges: ['1-2', '6'] })
  for (const file of [...merged.body.files, ...parts.body.files]) {
    secrets.push(String(new URL(file.download_url).searchParams.get('signature')))
    curl('-o', '/dev/null', local(server, file.download_url))
  }
  await api(server, key, '/v1/call/qr.create', { text: key })
  await api(server, key, '/v1/call/pdf.rotate', { key })
  await api(server, key, '/v1/call/pdf.split', { file: first.body.file_id, ranges: ['9'] })
  await fetch(`${server.base}/v1/call/qr.create`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: `{"text":"${key}`,
  })
  await fetch(`${server.base}/v1/me`, { headers: { Authorization: `Bearer ${key}x` } })
  flows.push('REST: me, 2 uploads, merge, split, 3 downloads, a QR of the key, errors, a broken body with the key')

  // MCP with the same key.
  await mcp(server, key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  await mcp(server, key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'qr_create', arguments: { text: key } } })
  await mcp(server, key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pdf_split', arguments: { file: 'file_nope', ranges: ['1'] } } })
  flows.push('MCP: tools/list, qr_create, a tool error')

  // The limits, and an internal error, which is logged.
  let limited = 0
  for (let call = 0; call < 70; call++) {
    if ((await api(server, key, '/v1/call/pdf.rotate', {})).status === 429) limited++
  }
  const big = join(dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(25 * 2 ** 20))
  const full = await upload(server, dashboardKey, big)
  chmodSync(join(data, 'partial'), 0o500)
  const internal = await api(server, dashboardKey, '/v1/call/qr.create', { text: dashboardKey })
  chmodSync(join(data, 'partial'), 0o700)
  assert.deepEqual([limited > 0, full.status, internal.status], [true, 507, 500])
  flows.push(`limits: ${limited} calls refused with 429, an upload refused with 507, an internal error with 500`)

  // The owner revokes the paired key, which then gets 401.
  const listed = await (await fetch(`${server.admin}/keys`, { headers: { Cookie: session } })).text()
  const revoke = /\/keys\/([^/"]+)\/revoke"><button [^>]*aria-label="Revoke log check agent"/
  const id = String(revoke.exec(listed)?.[1])
  await form(server, `/keys/${id}/revoke`, [], session)
  assert.equal((await api(server, key, '/v1/me')).status, 401)
  flows.push('the paired key revoked on Keys, then 401')
  await server.stop()

  const output = server.output.join('\n')
  console.log(`flows: ${flows.join('; ')}`)
  console.log(`server output: ${server.output.length} lines, ${output.length} characters`)
  const found = secrets.filter((secret) => secret.length >= 8 && output.includes(secret))
  console.log(`searched for ${secrets.length} values: the password, the session, 2 keys, the code in 2 forms, the pair_id and ${secrets.length - 7} link signatures`)
  assert.deepEqual(found.map((secret) => `${secret.slice(0, 4)}...`), [])
  console.log('ok none of them is in the output')
  writeFileSync(join(process.env.LIMITS_EVIDENCE ?? dir, 'server-output.txt'), output)
}

function rssMegabytes(pid: number) {
  const [, after] = readFileSync(`/proc/${pid}/status`, 'utf8')
    .split(/VmRSS:\s+/)
  return Number.parseInt(String(after)) / 1024
}

async function memory() {
  const data = join(dir, 'memory')
  const server = await startServer(data)
  // A key makes up to 60 calls a minute, so the load is spread over 20 keys.
  const keys = Array.from({ length: 20 }, (_, index) => storeKey(data, `memory ${index}`))
  let calls = 0
  const nextKey = () => String(keys[calls++ % keys.length])
  const pdfPath = join(dir, 'two.pdf')
  writeFileSync(pdfPath, await pdf(2))
  const ids: string[] = []
  for (const key of keys.slice(0, 2)) ids.push((await upload(server, key, pdfPath)).body.file_id)
  async function load(qrs: number, merges: number) {
    const jobs = [
      ...Array.from({ length: qrs }, (_, index) => () => api(server, nextKey(), '/v1/call/qr.create', { text: `memory ${index}` })),
      ...Array.from({ length: merges }, () => () => api(server, nextKey(), '/v1/call/pdf.merge', { files: ids })),
    ]
    // Two at a time, as many as the runner runs.
    const worker = async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) assert.equal((await job()).status, 200)
    }
    await Promise.all([worker(), worker()])
  }
  const started = performance.now()
  await load(100, 10)
  const baseline = rssMegabytes(server.pid)
  console.log(`after 100 QR codes and 10 merges: ${baseline.toFixed(1)} MB of RSS`)
  await load(900, 90)
  const after = rssMegabytes(server.pid)
  const seconds = ((performance.now() - started) / 1000).toFixed(0)
  console.log(`after 1000 QR codes and 100 merges: ${after.toFixed(1)} MB of RSS, ${(after - baseline).toFixed(1)} MB more, in ${seconds} s`)
  assert.ok(after - baseline <= 30, 'the limit is 30 MB more')
  console.log('ok it grew 30 MB or less')
  await server.stop()
}

if (mode === 'disk' || mode === 'all') await disk()
if (mode === 'logs' || mode === 'all') await logs()
if (mode === 'memory' || mode === 'all') await memory()
