import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json } from 'node:stream/consumers'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { JobResult } from '../src/tools/main.js'

const dir = mkdtempSync(join(tmpdir(), 'toolshed-live-'))
process.on('exit', () => rmSync(dir, { recursive: true }))
let jobs = 0

async function run(tool: string, input: unknown, paths: string[] = []) {
  const outputDir = join(dir, `out-${jobs++}`)
  mkdirSync(outputDir)
  const files = paths.map((path, index) => ({ id: `file_${index}`, path }))
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/tools.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdin.end(JSON.stringify({ tool, input, files, outputDir }))
  return (await json(child.stdout)) as JobResult
}

async function outputs(tool: string, input: unknown, paths: string[] = []) {
  const result = await run(tool, input, paths)
  assert.ok('files' in result, JSON.stringify(result))
  return result.files.map(({ path }) => path)
}

function shell(command: string, ...args: string[]) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function words(path: string) {
  return shell('pdftotext', path, '-')
    .split(/\s+/)
    .filter(Boolean)
    .join(',')
}

function pages(path: string) {
  return Number(/^Pages:\s+(\d+)/m.exec(shell('pdfinfo', path))?.[1])
}

async function save(name: string, document: PDFDocument) {
  const path = join(dir, name)
  writeFileSync(path, await document.save())
  return path
}

async function textPdf(name: string, labels: string[]) {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const label of labels) {
    document.addPage([200, 200])
      .drawText(label, { x: 50, y: 100, font })
  }
  return save(name, document)
}

async function heavyPdf(name: string) {
  const document = await PDFDocument.create()
  const image = document.context.stream(randomBytes(1024 * 10240), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 1024,
    Height: 10240,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  })
  const page = document.addPage()
  page.node.newXObject('Im', document.context.register(image))
  return save(name, document)
}

async function live() {
  const texts = ['https://example.com', 'Año nuevo, ¿qué tal? ñandú y pingüino', 'abcde '.repeat(400)
    .slice(0, 2000)]
  for (const text of texts) {
    for (const size of [64, 512, 2048]) {
      const [png = ''] = await outputs('qr.create', { text, size })
      const read = shell('zbarimg', '-q', '--raw', '-Sdisable', '-Sqrcode.enable', png)
      assert.equal(read, `${text}\n`)
    }
  }
  console.log('ok zbarimg reads every QR code, accents and 2000 characters included')

  for (let round = 0; round < 40; round++) {
    const alphabet = ['1234567890', 'ABC123$%', 'abcñé1', '😀a1', '漢字1A']
    const letters = Array.from(alphabet[round % alphabet.length] ?? '')
    let text = ''
    for (;;) {
      const next = text + letters[randomBytes(1)
        .readUInt8() % letters.length]
      if (next.length > 2000 || Buffer.byteLength(next) > 2330) break
      text = next
    }
    await outputs('qr.create', { text })
  }
  console.log('ok 40 random texts at the limit fit in a QR code')

  const a = await textPdf('a.pdf', ['A1', 'A2', 'A3'])
  const b = await textPdf('b.pdf', ['B1', 'B2', 'B3'])
  const [first = ''] = await outputs('pdf.split', { file: 'file_0', ranges: ['1-2'] }, [a])
  const merged = await outputs('pdf.merge', { files: ['file_0', 'file_1'] }, [first, b])
  assert.equal(words(merged[0] ?? ''), 'A1,A2,B1,B2,B3')
  console.log('ok pdftotext reads A1,A2,B1,B2,B3')

  const locked = join(dir, 'locked.pdf')
  shell('qpdf', '--encrypt', 'user', 'owner', '256', '--', a, locked)
  const rejected = await run('pdf.split', { file: 'file_0', ranges: ['1'] }, [locked])
  assert.ok('error' in rejected && rejected.error.code === 'not_a_pdf')
  console.log('ok a PDF encrypted by qpdf is not_a_pdf')

  const real = process.argv.slice(2)
  const long = await textPdf('long.pdf', Array.from({ length: 120 }, (_, index) => `p${index + 1}`))
  for (const path of [a, long, ...real]) {
    const count = pages(path)
    const half = Math.ceil(count / 2)
    const parts = await outputs('pdf.split', { file: 'file_0', ranges: [`1-${half}`, `${count}`] }, [path])
    const [joined = ''] = await outputs('pdf.merge', { files: ['file_0', 'file_1'] }, [path, b])
    assert.deepEqual(parts.map(pages), [half, 1])
    assert.equal(pages(joined), count + 3)
    for (const output of [...parts, joined]) shell('qpdf', '--check', output)
  }
  console.log(`ok pdfinfo and qpdf --check on 2 generated and ${real.length} given PDFs`)
}

async function perf() {
  const heavy = [await heavyPdf('h1.pdf'), await heavyPdf('h2.pdf')]
  const times: number[] = []
  for (let round = 0; round < 5; round++) {
    const start = performance.now()
    const [output = ''] = await outputs('pdf.merge', { files: ['file_0', 'file_1'] }, heavy)
    times.push(Math.round(performance.now() - start))
    assert.ok(statSync(output).size > 19e6)
  }
  times.sort((x, y) => x - y)
  console.log(`merge of two 10 MB PDFs, process included: median ${times[2]} ms [${times[0]}-${times[4]}]`)
  assert.ok((times[2] ?? Infinity) <= 500, 'the limit is 500 ms')
}

await live()
await perf()
