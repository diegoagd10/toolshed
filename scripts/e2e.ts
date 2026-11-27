// Run by scripts/e2e.sh against the container it starts. Repeats the live checks of T4 to T7,
// then the container's own: PDF bombs, restart, backup and restore, and memory.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { chromium } from 'playwright-core'

type FileAnswer = { file_id: string, name: string, download_url: string, pages?: number }
type Answer = { files: FileAnswer[], upload_url: string, command: string, error?: { code: string } }

const project = String(process.env.E2E_PROJECT)
const agent = String(process.env.E2E_AGENT)
const admin = String(process.env.E2E_ADMIN)
const password = String(process.env.OWNER_PASSWORD)
const [mode = 'all'] = process.argv.slice(2)
const dir = mkdtempSync(join(tmpdir(), 'toolshed-e2e-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

function compose(...args: string[]) {
  return execFileSync('docker', ['compose', '-p', project, ...args], { encoding: 'utf8' })
}

function inContainer(...args: string[]) {
  return compose('exec', '-T', 'toolshed', ...args)
}

function container() {
  return compose('ps', '-q', 'toolshed')
    .trim()
}

function restarts() {
  return execFileSync('docker', ['inspect', '-f', '{{.RestartCount}}', container()], { encoding: 'utf8' })
    .trim()
}

function curl(...args: string[]) {
  return execFileSync('curl', ['--silent', '--show-error', ...args], { encoding: 'utf8', maxBuffer: 2 ** 26 })
}

function words(path: string) {
  return execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' })
    .split(/\s+/)
    .filter(Boolean)
    .join(',')
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

// The owner's dashboard, driven with fetch from the dashboard's own origin.
class Owner {
  cookie = ''

  async signIn() {
    const response = await this.post('/login', [['password', password]])
    assert.equal(response.status, 303)
    this.cookie = String(String(response.headers.get('set-cookie'))
      .split(';')[0])
    return this
  }

  get(path: string) {
    return fetch(`${admin}${path}`, { headers: { Cookie: this.cookie }, redirect: 'manual' })
  }

  post(path: string, form: string[][], origin = admin) {
    return fetch(`${admin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: this.cookie },
      body: new URLSearchParams(form)
        .toString(),
      redirect: 'manual',
    })
  }

  async createKey(name: string) {
    assert.equal((await this.post('/keys', [['name', name]])).status, 303)
    const page = await (await this.get('/keys')).text()
    const secret = /<pre id="new-key">([^<]+)<\/pre>/.exec(page)?.[1]
    assert.ok(secret)
    const id = new RegExp(`action="/keys/(key_\\w+)/revoke"><button class="danger" aria-label="Revoke ${name}"`)
      .exec(page)?.[1]
    return { secret, id: String(id) }
  }

  async revoke(id: string) {
    assert.equal((await this.post(`/keys/${id}/revoke`, [])).status, 303)
  }
}

function api(key: string, method: string, path: string, body?: unknown) {
  const args = ['-X', method, '-H', `Authorization: Bearer ${key}`, `${agent}${path}`]
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
  return JSON.parse(curl(...args)) as Answer
}

function status(key: string, method: string, path: string, body?: unknown) {
  const args = ['-o', '/dev/null', '-w', '%{http_code}', '-X', method, `${agent}${path}`]
  if (key) args.push('-H', `Authorization: Bearer ${key}`)
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
  return curl(...args)
}

function upload(key: string, path: string, name: string) {
  const { upload_url: url } = api(key, 'POST', '/v1/uploads', { name })
  return JSON.parse(curl('--fail-with-body', '-T', path, url)) as FileAnswer
}

function download(file: FileAnswer | undefined, prefix: string) {
  const path = join(dir, `${prefix}-${file?.name}`)
  curl('--fail', '-o', path, String(file?.download_url))
  return path
}

function storedFiles() {
  return inContainer('sh', '-c', 'ls /data/files /data/partial | wc -l')
    .trim()
}

async function restApi(owner: Owner) {
  const { secret: key, id } = await owner.createKey('e2e rest')
  assert.equal(status('', 'GET', '/v1/me'), '401')
  const invalid = JSON.parse(curl('-X', 'POST', '-H', `Authorization: Bearer ${key}`, '-H', 'Content-Type: application/json', '-d', '{}', `${agent}/v1/call/qr.create`)) as { error: { code: string, message: string } }
  assert.match(JSON.stringify(invalid), /invalid_input.*text/)
  const llms = curl('--fail', `${agent}/llms.txt`)
  for (const tool of ['qr.create', 'pdf.merge', 'pdf.split']) assert.ok(llms.includes(tool), tool)
  console.log('ok T4 no key gives 401, a missing field gives invalid_input naming text, llms.txt lists the 3 tools')

  const a = upload(key, await textPdf('a.pdf', ['A1', 'A2']), 'a.pdf')
  const b = upload(key, await textPdf('b.pdf', ['B1', 'B2', 'B3']), 'b.pdf')
  const [merged] = api(key, 'POST', '/v1/call/pdf.merge', { files: [a.file_id, b.file_id] }).files
  const parts = api(key, 'POST', '/v1/call/pdf.split', { file: merged?.file_id, ranges: ['1-2', '3-5'] }).files
  assert.deepEqual(parts.map((part) => words(download(part, 'rest'))), ['A1,A2', 'B1,B2,B3'])
  console.log('ok T4 curl: upload 2 PDFs, merge, split and download; pdftotext reads A1,A2 and B1,B2,B3')

  const big = join(dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(51 * 2 ** 20, 1))
  const tooBig = curl('-o', '/dev/null', '-w', '%{http_code}', '-T', big, api(key, 'POST', '/v1/uploads', { name: 'big.bin' }).upload_url)
  assert.equal(tooBig, '413')
  const before = storedFiles()
  const half = join(dir, 'half.bin')
  writeFileSync(half, Buffer.alloc(40 * 2 ** 20, 2))
  const slow = spawn('curl', ['--silent', '--limit-rate', '4M', '-T', half, api(key, 'POST', '/v1/uploads', { name: 'half.bin' }).upload_url])
  await sleep(2000)
  const during = storedFiles()
  slow.kill('SIGKILL')
  await sleep(1000)
  assert.equal(Number(during), Number(before) + 1)
  assert.equal(storedFiles(), before)
  console.log(`ok T4 51 MB gives 413; mid-upload /data/files and /data/partial hold ${during} entries, after the cut ${before}, as before`)

  for (const input of [{ text: 'hi', format: 'svg' }, { text: 'hi' }]) {
    const [file] = api(key, 'POST', '/v1/call/qr.create', input).files
    const head = curl('-D', '-', '-o', '/dev/null', String(file?.download_url))
    assert.match(head, /content-disposition: attachment; filename=qr\.(svg|png)/i)
    assert.match(head, /x-content-type-options: nosniff/i)
  }
  console.log('ok T4 qr.svg and qr.png download with Content-Disposition: attachment and nosniff')

  await owner.revoke(id)
  assert.equal(status(key, 'GET', '/v1/me'), '401')
  console.log('ok T4 a revoked key gives 401')
}

async function mcpCall(client: Client, name: string, input: object) {
  const args = Object.fromEntries(Object.entries(input))
  const answer = await client.callTool({ name, arguments: args })
  const [first] = answer.content as { text: string }[]
  assert.ok(!answer.isError, first?.text)
  return JSON.parse(String(first?.text)) as Answer
}

async function mcp(owner: Owner) {
  const { secret: key, id } = await owner.createKey('e2e mcp')
  for (const version of ['2025-11-25', '2026-07-28']) {
    const options = version === '2026-07-28' ? { versionNegotiation: { mode: { pin: version } } } : {}
    const client = new Client({ name: 'e2e', version: '1.0.0' }, options)
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agent}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }))
    assert.equal(client.getNegotiatedProtocolVersion(), version)
    const send = async (path: string, name: string) => {
      const { command } = await mcpCall(client, 'file_upload', { name })
      return JSON.parse(curl('--fail-with-body', '-T', path, /'(.+)'$/.exec(command)?.[1] ?? '')) as FileAnswer
    }
    const a = await send(await textPdf('a.pdf', ['A1', 'A2']), 'a.pdf')
    const b = await send(await textPdf('b.pdf', ['B1', 'B2', 'B3']), 'b.pdf')
    const [merged] = (await mcpCall(client, 'pdf_merge', { files: [a.file_id, b.file_id] })).files
    const { files: parts } = await mcpCall(client, 'pdf_split', { file: merged?.file_id, ranges: ['1-2', '3-5'] })
    assert.deepEqual(parts.map((part) => words(download(part, version))), ['A1,A2', 'B1,B2,B3'])
    await client.close()
    console.log(`ok T5 MCP ${version}: file_upload, pdf_merge, pdf_split and download; pdftotext reads A1,A2 and B1,B2,B3`)
  }
  const listed = curl(...[
    ['-i', '-X', 'POST', `${agent}/mcp`],
    ['-H', `Authorization: Bearer ${key}`, '-H', 'Content-Type: application/json'],
    ['-H', 'Accept: application/json, text/event-stream'],
    ['-d', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
  ].flat())
  assert.equal(listed.split('\r\n')[0], 'HTTP/1.1 200 OK')
  console.log('ok T5 tools/list without MCP-Protocol-Version gives 200')
  await owner.revoke(id)
}

async function dashboard() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    let dialogs = 0
    page.on('dialog', (dialog) => {
      dialogs++
      void dialog.dismiss()
    })
    await page.goto(`${admin}/login`)
    await page.getByLabel('Password')
      .fill(password)
    await page.getByRole('button', { name: 'Sign in' })
      .click()
    await page.goto(`${admin}/keys`)
    const hostile = '<img src=x onerror=alert(1)>'
    await page.getByLabel('Agent name')
      .fill(hostile)
    await page.getByRole('button', { name: 'Create key' })
      .click()
    await page.waitForURL(`${admin}/keys`)
    const secret = await page.locator('#new-key')
      .textContent()
    assert.match(String(secret), /^ts_/)
    const response = await page.reload()
    assert.equal(response?.headers()['cache-control'], 'no-store')
    assert.equal(await page.locator('#new-key')
      .count(), 0)
    assert.ok(!(await page.content()).includes(String(secret)))
    assert.equal(await page.getByRole('cell', { name: hostile, exact: true })
      .count(), 1)
    await page.getByRole('button', { name: `Revoke ${hostile}` })
      .click()
    await page.waitForURL(`${admin}/keys`)
    assert.equal(dialogs, 0)
    assert.equal(status(String(secret), 'GET', '/v1/me'), '401')
    console.log('ok T6 Chromium: sign in, create a key named <img src=x onerror=alert(1)>, shown once, gone after reload (no-store), shown as text, no dialog, revoked gives 401')
  } finally {
    await browser.close()
  }
  const owner = await new Owner()
    .signIn()
  const keysBefore = await (await owner.get('/keys')).text()
  assert.equal((await owner.post('/keys', [['name', 'evil']], 'https://evil.example')).status, 403)
  const anonymous = new Owner()
  assert.equal((await anonymous.post('/keys', [['name', 'anon']])).status, 303)
  assert.equal(await (await owner.get('/keys')).text(), keysBefore)
  console.log('ok T6 a POST from another Origin gives 403 and one without a cookie goes to /login; the keys did not change')
  for (const path of ['/', '/keys', '/activity', '/login']) assert.equal(status('', 'GET', path), '404', path)
  console.log('ok T6 /, /keys, /activity and /login give 404 on the agent port')
}

async function pairing(owner: Owner) {
  const start = () => JSON.parse(curl('-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{"agent":"e2e agent"}', `${agent}/pair`)) as { pair_id: string, code: string }
  const claim = (id: string, wait: number) => curl('-w', '\n%{http_code}', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ pair_id: id, wait }), `${agent}/pair/token`)
  const pair = start()
  const waiting = spawn('curl', ['--silent', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ pair_id: pair.pair_id, wait: 25 }), `${agent}/pair/token`])
  const answer = (async () => {
    let body = ''
    for await (const chunk of waiting.stdout) body += String(chunk)
    return body
  })()
  await sleep(1000)
  assert.ok(!(await (await owner.get('/')).text()).includes(pair.code), 'the dashboard does not list the code')
  assert.equal((await owner.post('/pair/approve', [['code', pair.code]])).status, 303)
  const { key } = JSON.parse(await answer) as { key: string }
  assert.ok(key.startsWith('ts_'))
  assert.equal(claim(pair.pair_id, 0)
    .split('\n')
    .at(-1), '404')
  const [qr] = api(key, 'POST', '/v1/call/qr.create', { text: 'paired' }).files
  assert.equal(qr?.name, 'qr.png')
  console.log('ok T7 /pair, a waiting /pair/token, the code typed on Start; the key makes a QR, and a second claim gives 404')

  const late = start()
  const codes = []
  for (let attempt = 0; attempt < 6; attempt++) {
    codes.push((await owner.post('/pair/approve', [['code', 'WRONG-CODE']])).status)
  }
  codes.push((await owner.post('/pair/approve', [['code', late.code]])).status)
  assert.deepEqual(codes, [422, 422, 422, 422, 422, 422, 429])
  console.log(`ok T7 six wrong codes in a minute block the seventh, the right one: ${codes.join(', ')}`)
}

function bomb(megabytes: number) {
  const stream = deflateSync(Buffer.alloc(megabytes * 2 ** 20, 32))
  const head = `%PDF-1.5\n1 0 obj\n<</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length ${stream.length}>>\nstream\n`
  const path = join(dir, `bomb-${megabytes}.pdf`)
  writeFileSync(path, Buffer.concat([Buffer.from(head), stream, Buffer.from('\nendstream\nendobj\ntrailer\n<</Root 2 0 R>>\n%%EOF')]))
  return path
}

async function bombs(owner: Owner) {
  const { secret: key, id } = await owner.createKey('e2e bombs')
  const good = upload(key, await textPdf('good.pdf', ['G1']), 'good.pdf')
  const bad = [300, 600].map((megabytes) => upload(key, bomb(megabytes), `bomb-${megabytes}.pdf`))
  const merge = (file: FileAnswer) => new Promise<string>((resolve) => {
    const child = spawn('curl', ['--silent', '-X', 'POST', '-H', `Authorization: Bearer ${key}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ files: [file.file_id, good.file_id] }), `${agent}/v1/call/pdf.merge`])
    let body = ''
    child.stdout.on('data', (chunk) => body += String(chunk))
    child.on('close', () => resolve(body))
  })
  const answers = await Promise.all(bad.map(merge))
  for (const body of answers) assert.match(body, /too_much_memory/)
  assert.equal(curl('-o', '/dev/null', '-w', '%{http_code}', `${agent}/health`), '200')
  assert.equal(restarts(), '0')
  console.log('ok T9 two PDF bombs (300 and 600 MB) at once both give too_much_memory; /health is 200 and RestartCount is 0')
  await owner.revoke(id)
}

async function waitHealthy() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', container()], { encoding: 'utf8' })
      .trim()
    if (health === 'healthy') return
    await sleep(200)
  }
  assert.fail('the container did not become healthy')
}

async function restart(owner: Owner) {
  const { secret: key } = await owner.createKey('e2e restart')
  compose('restart', 'toolshed')
  await waitHealthy()
  assert.equal(status(key, 'GET', '/v1/me'), '200')
  assert.equal((await owner.get('/keys')).status, 200)
  console.log('ok T9 after docker compose restart the key authenticates and the dashboard session is still signed in')

  const backups = join(dir, 'backups')
  execFileSync(join(import.meta.dirname, 'backup.sh'), [backups], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const [backup = ''] = execFileSync('ls', [backups], { encoding: 'utf8' })
    .trim()
    .split('\n')
  const restored = `${project}-restored`
  execFileSync('docker', ['volume', 'create', restored], { stdio: 'ignore' })
  try {
    execFileSync('docker', ['run', '--rm', '-v', `${restored}:/data`, '-v', `${backups}:/backups:ro`, '--user', 'root', '--entrypoint', 'sh', 'toolshed', '-c', `install -o node -g node -m 600 /backups/${backup} /data/toolshed.db && chown node:node /data`])
    const server = spawn('docker', ['run', '--rm', '--name', restored, '-v', `${restored}:/data`, '-p', '127.0.0.1::4400', '-e', 'OWNER_PASSWORD=restored', '-e', 'PUBLIC_URL=http://localhost', '-e', 'ADMIN_URL=http://localhost', 'toolshed'], { stdio: 'ignore' })
    try {
      let port = ''
      for (let attempt = 0; attempt < 100 && !port; attempt++) {
        await sleep(200)
        try {
          port = execFileSync('docker', ['port', restored, '4400'], { encoding: 'utf8' })
            .trim()
            .split(':')
            .at(-1) ?? ''
          execFileSync('curl', ['--silent', '--fail', `http://127.0.0.1:${port}/health`], { stdio: 'ignore' })
        } catch {
          port = ''
        }
      }
      const me = curl('-o', '/dev/null', '-w', '%{http_code}', '-H', `Authorization: Bearer ${key}`, `http://127.0.0.1:${port}/v1/me`)
      assert.equal(me, '200')
      console.log(`ok T9 scripts/backup.sh wrote ${backup}; restored in an empty volume, the old key authenticates`)
    } finally {
      execFileSync('docker', ['stop', restored], { stdio: 'ignore' })
      await once(server, 'exit')
    }
  } finally {
    execFileSync('docker', ['volume', 'rm', restored], { stdio: 'ignore' })
  }
}

function anonMb() {
  const stat = inContainer('cat', '/sys/fs/cgroup/memory.stat')
  return Number(/^anon (\d+)$/m.exec(stat)?.[1]) / 2 ** 20
}

function anonText(values: number[]) {
  return `${Number(values.at(-1))
    .toFixed(1)} MB`
}

function summary(values: number[]) {
  const sorted = [...values].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity
  return { median, text: `median ${median.toFixed(1)} MB [${sorted[0]?.toFixed(1)}-${sorted.at(-1)
    ?.toFixed(1)}]` }
}

async function heavyPdf(name: string, megabytes: number) {
  const document = await PDFDocument.create()
  const side = Math.round(Math.sqrt(megabytes * 2 ** 20))
  const image = document.context.stream(randomBytes(side * side), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: side,
    Height: side,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  })
  document.addPage()
    .node
    .newXObject('Im', document.context.register(image))
  const path = join(dir, name)
  writeFileSync(path, await document.save({ useObjectStreams: false }))
  return path
}

async function memory(owner: Owner) {
  const idle = []
  for (let run = 0; run < 5; run++) {
    compose('restart', 'toolshed')
    await waitHealthy()
    await sleep(10_000)
    idle.push(anonMb())
    console.log(`   run ${run + 1}: ${anonText(idle)}`)
  }
  const resting = summary(idle)
  console.log(`perf T9 idle anon memory of the container: ${resting.text}`)
  assert.ok(resting.median <= 100, 'the limit is 100 MB')

  await owner.signIn()
  const { secret: key, id } = await owner.createKey('e2e memory')
  const a = upload(key, await heavyPdf('heavy-a.pdf', 20), 'heavy-a.pdf')
  const b = upload(key, await heavyPdf('heavy-b.pdf', 20), 'heavy-b.pdf')
  const peaks = []
  for (let round = 0; round < 5; round++) {
    let peak = anonMb()
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        peak = Math.max(peak, anonMb())
        await sleep(20)
      }
    })()
    const body = JSON.stringify({ files: [a.file_id, b.file_id] })
    const merges = [0, 1].map(() => new Promise<string>((resolve) => {
      const child = spawn('curl', ['--silent', '-X', 'POST', '-H', `Authorization: Bearer ${key}`, '-H', 'Content-Type: application/json', '-d', body, `${agent}/v1/call/pdf.merge`])
      let answer = ''
      child.stdout.on('data', (chunk) => answer += String(chunk))
      child.on('close', () => resolve(answer))
    }))
    for (const answer of await Promise.all(merges)) assert.match(answer, /"pages":2/)
    sampling = false
    await sampler
    peaks.push(peak)
    console.log(`   round ${round + 1}: ${peak.toFixed(1)} MB`)
  }
  const merging = summary(peaks)
  console.log(`perf T9 anon memory peak during two 20 MB merges at once: ${merging.text}`)
  assert.ok(Math.max(...peaks) <= 600, 'the limit is 600 MB')
  assert.equal(restarts(), '0')
  await owner.revoke(id)
}

const owner = await new Owner()
  .signIn()
if (mode === 'all' || mode === 'live') {
  await restApi(owner)
  await mcp(owner)
  await dashboard()
  await pairing(owner)
}
if (mode === 'all' || mode === 'docker') {
  await bombs(owner)
  await restart(owner)
}
if (mode === 'all' || mode === 'perf') await memory(owner)
console.log(`ok ${mode}`)
