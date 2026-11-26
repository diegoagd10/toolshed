import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { json } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { deflateSync } from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import type { Command } from '../src/runner/main.js'
import type { RunResult } from '../src/runner/runner.js'
import type { Job } from '../src/tools/job.js'

type Answer = { id: number, pong?: true, result?: RunResult }

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-runner-live-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
let ids = 0

function startRunner() {
  const child = spawn(process.execPath, [join(dist, 'runner.js')], { stdio: ['pipe', 'pipe', 'inherit'] })
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
  async function run(job: Job) {
    const { result } = await send({ id: ids++, job })
    assert.ok(result)
    return result
  }
  return { child, send, run, stop: () => child.stdin.end() }
}

function children(pid: number | undefined) {
  return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .trim()
}

function noChildren(pid: number | undefined) {
  try {
    return children(pid) === ''
  } catch {
    return true
  }
}

function job(tool: string, input: unknown, paths: string[]): Job {
  const files = paths.map((path, index) => ({ id: `file_${index}`, path }))
  const name = `out-${ids}-${randomBytes(4)
    .toString('hex')}`
  return { tool, input, files, outputDir: join(dir, name) }
}

function bomb(megabytes: number) {
  const stream = deflateSync(Buffer.alloc(megabytes * 2 ** 20, 32))
  const head = `%PDF-1.5\n1 0 obj\n<</Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length ${stream.length}>>\nstream\n`
  const path = join(dir, `bomb-${megabytes}.pdf`)
  writeFileSync(path, Buffer.concat([Buffer.from(head), stream, Buffer.from('\nendstream\nendobj\ntrailer\n<</Root 2 0 R>>\n%%EOF')]))
  return path
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
  document.addPage()
    .node
    .newXObject('Im', document.context.register(image))
  const path = join(dir, name)
  writeFileSync(path, await document.save())
  return path
}

async function bombs() {
  const runner = startRunner()
  for (const megabytes of [300, 600]) {
    const path = bomb(megabytes)
    const kb = Math.round(readFileSync(path).byteLength / 1024)
    for (let round = 0; round < 5; round++) {
      let slowest = 0
      let pinging = true
      const pings = (async () => {
        while (pinging) {
          const sent = performance.now()
          await runner.send({ id: ids++, ping: true })
          slowest = Math.max(slowest, performance.now() - sent)
          await sleep(50)
        }
      })()
      const started = performance.now()
      const result = await runner.run(job('pdf.split', { file: 'file_0', ranges: ['1'] }, [path]))
      const ms = Math.round(performance.now() - started)
      pinging = false
      await pings
      assert.ok('error' in result && result.error.code === 'too_much_memory', JSON.stringify(result))
      assert.ok(ms < 2000, `${ms} ms`)
      assert.ok(slowest < 100, `ping took ${slowest} ms`)
      console.log(`ok ${kb} KB that expand to ${megabytes} MB: too_much_memory in ${ms} ms, slowest ping ${slowest.toFixed(1)} ms`)
    }
  }
  runner.stop()
}

async function busy(heavy: string[]) {
  const runner = startRunner()
  const results = await Promise.all(Array.from({ length: 13 }, () => runner.run(job('pdf.merge', { files: ['file_0', 'file_1'] }, heavy))))
  const codes = results.map((result) => ('error' in result ? result.error.code : 'files'))
  assert.equal(codes.filter((code) => code === 'files').length, 12, codes.join())
  assert.equal(codes.filter((code) => code === 'busy').length, 1, codes.join())
  assert.ok(noChildren(runner.child.pid))
  console.log(`ok 13 merges of two 10 MB PDFs at once: 12 finish and 1 is busy; pgrep -P ${runner.child.pid} is empty`)
  runner.stop()
}

async function killParent() {
  const runner = startRunner()
  const fifo = join(dir, 'never-written.pdf')
  execFileSync('mkfifo', [fifo])
  void runner.run(job('pdf.split', { file: 'file_0', ranges: ['1'] }, [fifo]))
  while (noChildren(runner.child.pid)) await sleep(20)
  const child = children(runner.child.pid)
  runner.child.kill('SIGKILL')
  await sleep(5000)
  assert.ok(!existsSync(`/proc/${child}`), `child ${child} is still alive`)
  console.log(`ok kill -9 to the runner with a job running: child ${child} is gone 5 s later`)
}

async function perf(heavy: string[]) {
  const runner = startRunner()
  const direct: number[] = []
  const isolated: number[] = []
  async function base() {
    const { outputDir, ...rest } = job('pdf.merge', { files: ['file_0', 'file_1'] }, heavy)
    mkdirSync(outputDir)
    const child = spawn(process.execPath, [join(dist, 'tools.js')], { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdin.end(JSON.stringify({ ...rest, outputDir }))
    const result = (await json(child.stdout)) as RunResult
    assert.ok('files' in result)
  }
  async function viaRunner() {
    const result = await runner.run(job('pdf.merge', { files: ['file_0', 'file_1'] }, heavy))
    assert.ok('files' in result)
  }
  for (let round = 0; round < 5; round++) {
    for (const [times, measured] of [[direct, base], [isolated, viaRunner]] as const) {
      const started = performance.now()
      await measured()
      times.push(Math.round(performance.now() - started))
    }
  }
  const summary = (times: number[]) => {
    times.sort((x, y) => x - y)
    return `median ${times[2]} ms [${times[0]}-${times[4]}]`
  }
  console.log(`merge of two 10 MB PDFs, T1 process: ${summary(direct)}; through the runner: ${summary(isolated)}`)
  const added = (isolated[2] ?? Infinity) - (direct[2] ?? 0)
  assert.ok(added <= 200, `the runner adds ${added} ms; the limit is 200 ms`)
  console.log(`ok the runner adds ${added} ms to the median`)
  runner.stop()
}

const heavy = [await heavyPdf('h1.pdf'), await heavyPdf('h2.pdf')]
await bombs()
await busy(heavy)
await killParent()
await perf(heavy)
