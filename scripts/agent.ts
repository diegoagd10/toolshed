import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { PDFDocument, StandardFonts } from 'pdf-lib'

type FileAnswer = { file_id: string, name: string, download_url: string }

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-agent-live-'))
const data = join(dir, 'data')
const publicUrl = 'https://tools.example.com'

// The same flags as npm start.
const server = spawn(process.execPath, ['--max-semi-space-size=1', join(dist, 'main.js')], {
  env: {
    ...process.env,
    OWNER_PASSWORD: 'owner',
    PUBLIC_URL: publicUrl,
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
const base = `http://localhost:${port}`

const created = execFileSync(process.execPath, [join(dist, 'store.js'), data], {
  input: `${JSON.stringify({ do: 'key.create', name: 'live check' })}\n`,
  encoding: 'utf8',
})
const key = (JSON.parse(created) as { result: { secret: string } }).result.secret

// Links name PUBLIC_URL, as an agent would see them. The script sends them to the local port.
function local(url: string) {
  return url.replace(publicUrl, base)
}

function curl(...args: string[]) {
  return execFileSync('curl', ['--silent', '--show-error', ...args], { encoding: 'utf8', maxBuffer: 2 ** 26 })
}

function api(method: string, path: string, body?: unknown) {
  const args = ['-X', method, '-H', `Authorization: Bearer ${key}`, `${base}${path}`]
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
  return JSON.parse(curl(...args)) as { files: FileAnswer[], upload_url: string, command: string }
}

function upload(path: string, name: string) {
  const { command } = api('POST', '/v1/uploads', { name })
  const [program = '', ...args] = command.replace('<path>', path)
    .split(' ')
    .map((part) => part.replace(/^'|'$/g, ''))
  const url = local(String(args.at(-1)))
  return JSON.parse(execFileSync(program, [...args.slice(0, -1), url], { encoding: 'utf8' })) as FileAnswer
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

function rssMb(pid: number | undefined) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]) / 1024
}

async function flow() {
  const a = upload(await textPdf('a.pdf', ['A1', 'A2']), 'a.pdf')
  const b = upload(await textPdf('b.pdf', ['B1', 'B2', 'B3']), 'b.pdf')
  const [merged] = api('POST', '/v1/call/pdf.merge', { files: [a.file_id, b.file_id] }).files
  const parts = api('POST', '/v1/call/pdf.split', { file: merged?.file_id, ranges: ['1-2', '3-5'] }).files
  const texts = parts.map(({ name, download_url: url }) => {
    const path = join(dir, name)
    curl('--fail', '-o', path, local(url))
    return words(path)
  })
  assert.deepEqual(texts, ['A1,A2', 'B1,B2,B3'])
  console.log('ok curl: upload 2 PDFs, merge, split and download; pdftotext reads A1,A2 and B1,B2,B3')
}

function headers() {
  for (const input of [{ text: 'hi', format: 'svg' }, { text: 'hi' }]) {
    const [file] = api('POST', '/v1/call/qr.create', input).files
    const head = curl('-D', '-', '-o', '/dev/null', local(file?.download_url ?? ''))
    assert.match(head, /content-disposition: attachment; filename=qr\.(svg|png)/i)
    assert.match(head, /x-content-type-options: nosniff/i)
    console.log(`ok ${file?.name}: ${head.split('\r\n')
      .filter((line) => /^(content-type|content-disposition|x-content-type-options):/i.test(line))
      .join(' | ')}`)
  }
}

async function limits() {
  const big = join(dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(51 * 2 ** 20, 1))
  const { upload_url: url } = api('POST', '/v1/uploads', { name: 'big.bin' })
  const status = curl('-o', '/dev/null', '-w', '%{http_code}', '-T', big, local(url))
  assert.equal(status, '413')
  console.log('ok curl -T of 51 MB gives 413')

  const files = () => new DatabaseSync(join(data, 'toolshed.db'), { timeout: 5000 })
    .prepare('SELECT count(*) AS n FROM files')
    .get()?.n
  const before = files()
  const half = join(dir, 'half.bin')
  writeFileSync(half, Buffer.alloc(40 * 2 ** 20, 2))
  const slow = spawn('curl', ['--silent', '--limit-rate', '4M', '-T', half, local(api('POST', '/v1/uploads', { name: 'half.bin' }).upload_url)])
  while (readdirSync(join(data, 'partial')).length === 0) await sleep(20)
  await sleep(1000)
  slow.kill('SIGKILL')
  await sleep(500)
  assert.deepEqual(readdirSync(join(data, 'partial')), [])
  assert.equal(files(), before)
  console.log('ok curl killed in the middle of an upload: no partial file and no new row')
}

async function perf() {
  const file = join(dir, 'fifty.bin')
  writeFileSync(file, Buffer.alloc(50 * 2 ** 20 - 1024, 3))
  const growth: number[] = []
  for (let round = 0; round < 5; round++) {
    const { upload_url: url } = api('POST', '/v1/uploads', { name: 'fifty.bin' })
    const before = rssMb(server.pid)
    let peak = before
    const sampler = setInterval(() => {
      peak = Math.max(peak, rssMb(server.pid))
    }, 10)
    const sent = spawn('curl', ['--silent', '--fail', '-o', '/dev/null', '-T', file, local(url)])
    const [code] = await once(sent, 'exit') as [number]
    clearInterval(sampler)
    assert.equal(code, 0)
    growth.push(Math.round(peak - before))
  }
  console.log(`rounds: ${growth.join(', ')}`)
  growth.sort((x, y) => x - y)
  console.log(`server RSS growth during a 50 MB upload: median ${growth[2]} MB [${growth[0]}-${growth[4]}]`)
  assert.ok((growth[4] ?? Infinity) <= 30, 'the limit is 30 MB')
  console.log('ok every round grew 30 MB or less')
}

await flow()
headers()
await limits()
await perf()
server.kill('SIGTERM')
await once(server, 'exit')
