import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { buffer } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDeflate } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import { onTestFinished, test } from 'vite-plus/test'
import type { Job } from '../tools/job.js'
import type { Command } from './main.js'
import type { Limits, RunResult } from './runner.js'

type Answer = { id: number, pong?: true, result?: RunResult }

const program = join(import.meta.dirname, '../../dist/runner.js')

async function workDir() {
  const dir = await mkdtemp(join(tmpdir(), 'toolshed-runner-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function startRunner(limits: Partial<Limits> = {}, env = process.env) {
  const args = Object.keys(limits).length > 0 ? [JSON.stringify(limits)] : []
  const child = spawn(process.execPath, [program, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  // Ending stdin lets the runner exit by itself, which writes its coverage.
  onTestFinished(async () => {
    child.stdin.end()
    await closed
  })
  const waiting = new Map<number, (answer: Answer) => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const answer = JSON.parse(line) as Answer
    waiting.get(answer.id)?.(answer)
  })
  function send(command: Command) {
    const answered = new Promise<Answer>((resolve) => waiting.set(command.id, resolve))
    child.stdin.write(`${JSON.stringify(command)}\n`)
    return answered
  }
  async function run(id: number, job: Job) {
    const { result } = await send({ id, job })
    assert.ok(result)
    return result
  }
  return { child, send, run }
}

function childrenOf(pid: number | undefined) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
    .split(' ')
    .filter(Boolean)
    .map(Number)
}

async function until(done: () => boolean, ms = 5_000) {
  const deadline = performance.now() + ms
  while (!done()) {
    assert.ok(performance.now() < deadline, 'gave up waiting')
    await sleep(20)
  }
}

async function pdf(pages: number) {
  const document = await PDFDocument.create()
  for (let page = 0; page < pages; page++) document.addPage([100, 100])
  return document.save()
}

// An object stream of spaces: a few hundred KB that expand to `megabytes` when pdf-lib loads it.
async function bomb(megabytes: number) {
  const deflate = createDeflate()
  const compressed = buffer(deflate)
  const block = Buffer.alloc(2 ** 20, 32)
  for (let written = 0; written < megabytes; written++) deflate.write(block)
  deflate.end()
  const stream = await compressed
  const head = `%PDF-1.5\n1 0 obj\n<</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length ${stream.length}>>\nstream\n`
  const tail = '\nendstream\nendobj\ntrailer\n<</Root 2 0 R>>\n%%EOF'
  return Buffer.concat([Buffer.from(head), stream, Buffer.from(tail)])
}

async function splitJob(dir: string, name: string, data?: Uint8Array): Promise<Job> {
  const path = join(dir, `${name}.pdf`)
  if (data) await writeFile(path, data)
  else execFileSync('mkfifo', [path])
  const files = [{ id: 'file_a', path }]
  return { tool: 'pdf.split', input: { file: 'file_a', ranges: ['1'] }, files, outputDir: join(dir, name) }
}

async function assertNoOutput(job: Job) {
  assert.deepEqual((await readdir(join(job.outputDir, '..'))).filter((name) => name.startsWith('out')), [])
}

test('a good job gives its files in outputDir and leaves nothing beside it', async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in', await pdf(2)), outputDir: join(dir, 'out') }
  const result = await startRunner()
    .run(1, { ...job, input: { file: 'file_a', ranges: ['1', '2'] } })
  assert.ok('files' in result, JSON.stringify(result))
  assert.deepEqual(result.files.map(({ name, path }) => [name, path]), [
    ['pages-1.pdf', join(dir, 'out', '0')],
    ['pages-2.pdf', join(dir, 'out', '1')],
  ])
  assert.deepEqual((await readdir(dir)).sort(), ['in.pdf', 'out'])
})

test('a tool error comes back as it is, and outputDir does not appear', async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in', Buffer.from('not a pdf')), outputDir: join(dir, 'out') }
  const result = await startRunner()
    .run(1, job)
  assert.ok('error' in result)
  assert.equal(result.error.code, 'not_a_pdf')
  await assertNoOutput(job)
})

test('a PDF that expands to 300 MB is killed for too_much_memory', { timeout: 20_000 }, async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in', await bomb(300)), outputDir: join(dir, 'out') }
  const runner = startRunner()
  const started = performance.now()
  assert.deepEqual(await runner.run(1, job), {
    error: { code: 'too_much_memory', message: 'the job used more than 256 MB' },
  })
  assert.ok(performance.now() - started < 10_000)
  await assertNoOutput(job)
  assert.deepEqual(childrenOf(runner.child.pid), [])
})

test('a job longer than the limit is killed for timeout', async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in'), outputDir: join(dir, 'out') }
  assert.deepEqual(await startRunner({ timeoutMs: 300 })
    .run(1, job), {
    error: { code: 'timeout', message: 'the job ran longer than 0.3 s' },
  })
  await assertNoOutput(job)
})

const busyResult = {
  error: { code: 'busy', message: '2 jobs are running and 10 are waiting; try again later' },
}

test('with 2 running and 10 waiting, the 13th job is busy and the other 12 finish', { timeout: 30_000 }, async () => {
  const dir = await workDir()
  const runner = startRunner({ running: 2, waiting: 10 })
  const data = await pdf(1)
  const fifos: string[] = []
  async function start(index: number) {
    const job = await splitJob(dir, `job${index}`)
    fifos[index] = job.files[0]?.path ?? ''
    return runner.run(index, { ...job, outputDir: join(dir, `out${index}`) })
  }
  const release = (index: number) => writeFile(fifos[index] ?? '', data)
  const first = Array.from({ length: 13 }, (_, index) => start(index))
  assert.deepEqual(await first[12], busyResult)
  await until(() => childrenOf(runner.child.pid).length === 2)
  assert.deepEqual(await runner.send({ id: 99, ping: true }), { id: 99, pong: true })
  await release(0)
  await until(() => existsSync(join(dir, 'out0')))
  // A finished job hands its place to a waiting one, so the queue has room for one more, not two.
  const kept = start(13)
  const rejected = start(14)
  assert.deepEqual(await Promise.race([rejected, sleep(1_000)
    .then(() => 'no answer')]), busyResult)
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]) await release(index)
  const outcomes = await Promise.all([...first.slice(0, 12), kept])
  assert.deepEqual(outcomes.map((outcome) => 'files' in outcome), Array.from({ length: 13 }, () => true))
  assert.equal(childrenOf(runner.child.pid).length, 0)
})

test('a child killed in the middle gives crashed and leaves no output', async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in'), outputDir: join(dir, 'out') }
  const runner = startRunner()
  const result = runner.run(1, job)
  await until(() => childrenOf(runner.child.pid).length === 1)
  process.kill(childrenOf(runner.child.pid)[0] ?? 0, 'SIGKILL')
  assert.deepEqual(await result, {
    error: { code: 'crashed', message: 'the job stopped before it finished' },
  })
  await assertNoOutput(job)
})

test('without setpriv a job does not start', async () => {
  const dir = await workDir()
  const job = { ...await splitJob(dir, 'in', await pdf(1)), outputDir: join(dir, 'out') }
  assert.deepEqual(await startRunner({}, { ...process.env, PATH: '' })
    .run(1, job), {
    error: { code: 'crashed', message: 'the job could not start' },
  })
  await assertNoOutput(job)
})

test('kill -9 to the runner kills its child too', async () => {
  const dir = await workDir()
  const runner = startRunner()
  void runner.run(1, { ...await splitJob(dir, 'in'), outputDir: join(dir, 'out') })
  await until(() => childrenOf(runner.child.pid).length === 1)
  const [child] = childrenOf(runner.child.pid)
  runner.child.kill('SIGKILL')
  await until(() => !existsSync(`/proc/${child}`))
})
