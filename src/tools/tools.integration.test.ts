import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, text } from 'node:stream/consumers'
import jsqr from 'jsqr'
import { PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib'
import { PNG } from 'pngjs'
import { onTestFinished, test } from 'vite-plus/test'
import type { Job, JobFile, JobResult } from './main.js'

type Input = { id: string, data: Uint8Array | string }

function start(job: unknown) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../../dist/tools.js')], {
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  child.stdin.end(JSON.stringify(job))
  return child
}

async function prepare(tool: string, input: unknown, inputs: Input[]): Promise<Job> {
  const dir = await mkdtemp(join(tmpdir(), 'toolshed-tools-'))
  const outputDir = await mkdtemp(join(tmpdir(), 'toolshed-output-'))
  onTestFinished(async () => {
    await rm(dir, { recursive: true })
    await rm(outputDir, { recursive: true })
  })
  const files = inputs.map(({ id }, index) => ({ id, path: join(dir, String(index)) }))
  for (const [index, { data }] of inputs.entries()) await writeFile(join(dir, String(index)), data)
  return { tool, input, files, outputDir }
}

async function succeeds(tool: string, input: unknown, inputs: Input[] = []): Promise<JobFile[]> {
  const result = (await json(start(await prepare(tool, input, inputs)).stdout)) as JobResult
  assert.ok('files' in result, JSON.stringify(result))
  for (const { path, bytes } of result.files) assert.equal((await readFile(path)).byteLength, bytes)
  return result.files
}

async function fails(code: string, tool: string, input: unknown, inputs: Input[] = []) {
  const job = await prepare(tool, input, inputs)
  const result = (await json(start(job).stdout)) as JobResult
  assert.ok('error' in result, JSON.stringify(result))
  assert.equal(result.error.code, code)
  assert.deepEqual(await readdir(job.outputDir), [])
  return result.error.message
}

async function pdf(widths: number[]) {
  const document = await PDFDocument.create()
  for (const width of widths) document.addPage([width, 100])
  return document.save({ useObjectStreams: false, addDefaultPage: false })
}

async function widthsOf(file: JobFile | undefined) {
  assert.ok(file)
  const document = await PDFDocument.load(await readFile(file.path))
  return document.getPages()
    .map((page) => page.getWidth())
}

async function decode(file: JobFile | undefined) {
  assert.ok(file)
  const image = PNG.sync.read(await readFile(file.path))
  return jsqr.default(new Uint8ClampedArray(image.data), image.width, image.height)?.data
}

const a = { id: 'file_a', data: await pdf([101, 102, 103, 104, 105]) }
const b = { id: 'file_b', data: await pdf([201, 202]) }

for (const content of [
  'https://example.com',
  'Año nuevo, ¿qué tal? ñandú €',
  'x'.repeat(2000),
  'á'.repeat(1165),
]) {
  test(`qr.create encodes ${content.slice(0, 30)} (${content.length})`, async () => {
    const [file, ...rest] = await succeeds('qr.create', { text: content })
    assert.deepEqual(rest, [])
    assert.equal(file?.name, 'qr.png')
    assert.equal(file.mime, 'image/png')
    assert.equal(await decode(file), content)
  })
}

for (const [text, size, width] of [
  ['x', 300, 300],
  ['x'.repeat(500), 64, 186],
] as const) {
  test(`qr.create fits ${text.length} characters in ${size} with whole pixels`, async () => {
    const [file] = await succeeds('qr.create', { text, size })
    assert.ok(file)
    const image = PNG.sync.read(await readFile(file.path))
    assert.deepEqual([image.width, image.height], [width, width])
    assert.equal(await decode(file), text)
  })
}

test('qr.create gives an SVG', async () => {
  const [file] = await succeeds('qr.create', { text: 'x', format: 'svg', size: 300 })
  assert.equal(file?.name, 'qr.svg')
  assert.equal(file.mime, 'image/svg+xml')
  assert.match(await readFile(file.path, 'utf8'), /^<svg [^>]*width="300"/)
})

test('pdf.merge keeps the order, and repeats a file given twice', async () => {
  const [file, ...rest] = await succeeds(
    'pdf.merge',
    { files: ['file_b', 'file_a', 'file_b'] },
    [a, b],
  )
  assert.deepEqual(rest, [])
  assert.equal(file?.name, 'merged.pdf')
  assert.equal(file.mime, 'application/pdf')
  assert.deepEqual(await widthsOf(file), [201, 202, 101, 102, 103, 104, 105, 201, 202])
})

test('pdf.split gives one file per range, and repeated ranges do not collide', async () => {
  const files = await succeeds('pdf.split', { file: 'file_a', ranges: ['1-2', '5', '5'] }, [a])
  assert.deepEqual(files.map(({ name }) => name), ['pages-1-2.pdf', 'pages-5.pdf', 'pages-5.pdf'])
  assert.deepEqual(await Promise.all(files.map(widthsOf)), [[101, 102], [105], [105]])
})

test('pdf.split leaves nothing of the other pages in the file', async () => {
  const document = await PDFDocument.create()
  const shown = document.addPage([101, 100])
  const hidden = document.addPage([102, 100])
  hidden.node.addContentStream(document.context.register(document.context.stream('% SECRET-CONTENT')))
  const link = { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 9, 9], Dest: [hidden.ref, 'Fit'] }
  shown.node.addAnnot(document.context.register(document.context.obj(link)))
  const action = { Type: 'Annot', Subtype: 'Link', A: { S: 'GoTo', D: [hidden.ref, 'Fit'] } }
  shown.node.addAnnot(document.context.register(document.context.obj(action)))
  shown.node.set(PDFName.of('B'), document.context.obj([0, hidden.ref]))
  shown.node.set(PDFName.of('Empty'), document.context.obj([]))
  const field = document.getForm()
    .createTextField('name')
  field.setText('SECRET-VALUE')
  field.addToPage(hidden)
  field.addToPage(shown)
  field.acroField.dict.set(PDFName.of('TU'), PDFString.of('SECRET-LABEL'))
  const source = { id: 'file_a', data: await document.save() }

  const [file] = await succeeds('pdf.split', { file: 'file_a', ranges: ['1'] }, [source])
  assert.ok(file)
  assert.deepEqual(await widthsOf(file), [101])
  const output = await PDFDocument.load(await readFile(file.path))
  const objects = output.context.enumerateIndirectObjects()
    .map(([, object]) => object)
  const text = objects.map((object) => object.toString())
    .join('\n')
  const contents = objects.filter((object) => object instanceof PDFRawStream)
    .map((stream) => stream.getContentsString())
  assert.equal(text.match(/\/Type \/Page\b/g)?.length, 1)
  assert.doesNotMatch(text, /SECRET-LABEL/)
  assert.doesNotMatch(contents.join('\n'), /SECRET-CONTENT/)
})

for (const range of ['0', '3-2', '9', '1-6', '0-1']) {
  test(`pdf.split rejects the range ${range} of 5 pages`, async () => {
    const message = await fails('bad_range', 'pdf.split', { file: 'file_a', ranges: ['1', range] }, [a])
    assert.ok(message.includes(range))
  })
}

for (const range of ['a', '', '1-', '-1', '1-2-3', '1 ', '1.5', '1'.repeat(7)]) {
  test(`pdf.split rejects the range ${JSON.stringify(range)} as input`, async () => {
    const message = await fails('invalid_input', 'pdf.split', { file: 'file_a', ranges: [range] }, [a])
    assert.match(message, /ranges\.0/)
  })
}

const encrypted = Buffer.from(Buffer.from(b.data)
  .toString('latin1')
  .replace(/trailer\s*<</, '$& /Encrypt 1 0 R'), 'latin1')
for (const [label, data] of [
  ['text', 'this is not a PDF'],
  ['empty', ''],
  ['only a header', '%PDF-1.7\n'],
  ['truncated', a.data.slice(0, 200)],
  ['encrypted', encrypted],
  ['without pages', await pdf([])],
] as const) {
  test(`a file that is ${label} is not a PDF`, async () => {
    const inputs = [a, { id: 'file_bad', data }]
    const message = await fails('not_a_pdf', 'pdf.merge', { files: ['file_a', 'file_bad'] }, inputs)
    assert.match(message, /file_bad/)
    await fails('not_a_pdf', 'pdf.split', { file: 'file_bad', ranges: ['1'] }, inputs)
  })
}

for (const [field, tool, input] of [
  ['text', 'qr.create', {}],
  ['text', 'qr.create', { text: '' }],
  ['text', 'qr.create', { text: 'x'.repeat(2001) }],
  ['text', 'qr.create', { text: 'á'.repeat(1166) }],
  ['size', 'qr.create', { text: 'x', size: 63 }],
  ['size', 'qr.create', { text: 'x', size: 2049 }],
  ['format', 'qr.create', { text: 'x', format: 'gif' }],
  ['sise', 'qr.create', { text: 'x', sise: 100 }],
  ['files', 'pdf.merge', { files: ['file_a'] }],
  ['files', 'pdf.merge', { files: Array.from({ length: 51 }, () => 'file_a') }],
  ['files.0', 'pdf.merge', { files: ['../etc/passwd', 'file_a'] }],
  ['ranges', 'pdf.split', { file: 'file_a', ranges: [] }],
] as const) {
  const shown = JSON.stringify(input)
    .slice(0, 40)
  test(`${tool} names ${field} in ${shown}`, async () => {
    assert.ok((await fails('invalid_input', tool, input, [a])).includes(field))
  })
}

test('a missing file is named', async () => {
  const message = await fails('file_not_found', 'pdf.merge', { files: ['file_a', 'file_x'] }, [a])
  assert.match(message, /file_x/)
})

test('an unknown tool is named', async () => {
  assert.match(await fails('tool_not_found', 'pdf.fold', {}), /pdf\.fold/)
})

test('a failure that is not about the input exits non-zero without a result', async () => {
  const job = await prepare('qr.create', { text: 'x' }, [])
  const child = start({ ...job, outputDir: join(job.outputDir, 'missing') })
  const [output, code] = await Promise.all([
    text(child.stdout),
    new Promise((resolve) => child.once('close', resolve)),
  ])
  assert.equal(output, '')
  assert.equal(code, 1)
})
