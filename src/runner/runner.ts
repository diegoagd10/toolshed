import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import type { Job, JobResult } from '../tools/job.js'

export type RunnerErrorCode = 'busy' | 'crashed' | 'timeout' | 'too_much_memory'
export type RunResult = JobResult | { error: { code: RunnerErrorCode, message: string } }

export type Limits = {
  maxRssBytes: number
  timeoutMs: number
  running: number
  waiting: number
}

export const defaultLimits: Limits = {
  maxRssBytes: 256 * 2 ** 20,
  timeoutMs: 30_000,
  running: 2,
  waiting: 10,
}

const program = join(import.meta.dirname, 'tools.js')
const pollMs = 10

function failure(code: RunnerErrorCode, message: string): RunResult {
  return { error: { code, message } }
}

// Read synchronously, and only between the 'spawn' and 'exit' events: until Node emits 'exit',
// the child is not reaped, so /proc/<pid> still exists. A zombie has no VmRSS line and gives NaN.
function rssBytes(pid: number) {
  const [, after] = readFileSync(`/proc/${pid}/status`, 'utf8')
    .split(/VmRSS:\s+/)
  return Number.parseInt(String(after)) * 1024
}

export class Runner {
  readonly limits: Limits
  #running = 0
  readonly #waiting: (() => void)[] = []

  constructor(limits: Limits = defaultLimits) {
    this.limits = limits
  }

  // Runs a job in its own process. `outputDir` must not exist. It appears only if the job succeeds.
  async run(job: Job): Promise<RunResult> {
    if (this.#running < this.limits.running) this.#running++
    else if (this.#waiting.length < this.limits.waiting) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve))
    } else {
      const { running, waiting } = this.limits
      return failure('busy', `${running} jobs are running and ${waiting} are waiting; try again later`)
    }
    try {
      return await this.#isolate(job)
    } finally {
      const next = this.#waiting.shift()
      if (next) next()
      else this.#running--
    }
  }

  async #isolate(job: Job): Promise<RunResult> {
    const partial = `${job.outputDir}.partial`
    const input = `${job.outputDir}.job.json`
    try {
      await mkdir(partial, { recursive: true })
      await writeFile(input, JSON.stringify({ ...job, outputDir: partial }))
      const result = await this.#spawn(input)
      if ('error' in result) return result
      await rename(partial, job.outputDir)
      const moved = (path: string) => join(job.outputDir, basename(path))
      return { files: result.files.map((file) => ({ ...file, path: moved(file.path) })) }
    } finally {
      await rm(partial, { recursive: true, force: true })
      await rm(input, { force: true })
    }
  }

  async #spawn(input: string): Promise<RunResult> {
    const { maxRssBytes, timeoutMs } = this.limits
    const stdin = await open(input)
    // The kernel kills the child with SIGKILL when this process dies, even by kill -9.
    const child = spawn('setpriv', ['--pdeathsig', 'KILL', '--', process.execPath, program], {
      stdio: [stdin.fd, 'pipe', 'ignore'],
    }) as ChildProcessByStdio<null, Readable, null>
    const output = text(child.stdout)
    let verdict: RunResult | undefined
    const stop = (code: RunnerErrorCode, message: string) => {
      verdict ??= failure(code, message)
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop('timeout', `the job ran longer than ${timeoutMs / 1000} s`), timeoutMs)
    const megabytes = Math.round(maxRssBytes / 2 ** 20)
    let watch: NodeJS.Timeout | undefined
    child.once('spawn', () => {
      watch = setInterval(() => {
        const message = `the job used more than ${megabytes} MB`
        if (rssBytes(Number(child.pid)) > maxRssBytes) stop('too_much_memory', message)
      }, pollMs)
    })
    child.once('exit', () => clearInterval(watch))
    child.once('error', () => {
      verdict ??= failure('crashed', 'the job could not start')
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    // Every listener is in place before the first await: 'spawn' and 'error' come on the next tick.
    await stdin.close()
    const code = await closed
    clearTimeout(timer)
    if (verdict) return verdict
    if (code !== 0) return failure('crashed', 'the job stopped before it finished')
    return JSON.parse(await output) as JobResult
  }
}
