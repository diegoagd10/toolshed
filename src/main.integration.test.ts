import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, onTestFinished, test } from 'vite-plus/test'
import type { Environment } from './config.js'

const data = mkdtempSync(join(tmpdir(), 'toolshed-main-'))
afterAll(() => rmSync(data, { recursive: true }))

const env: Environment = {
  OWNER_PASSWORD: 'sekret-owner',
  PUBLIC_URL: 'https://tools.example.com',
  ADMIN_URL: 'http://admin.lan',
  DATA: data,
}

function run(env: Environment) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/main.js')], {
    env: { ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const exited = once(child, 'close')
    .then(([code, signal]) => ({ code, signal, output }))
  return { child, exited }
}

async function healthy(port: number, exited: Promise<{ output: string }>) {
  let stopped: string | undefined
  void exited.then(({ output }) => {
    stopped = output
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(stopped, undefined, `main exited early: ${stopped}`)
    const status = await fetch(`http://localhost:${port}/health`)
      .then(
        (response) => response.status,
        () => undefined,
      )
    if (status === 200) return
    await sleep(100)
  }
  assert.fail(`port ${port} never became healthy`)
}

const required = ['OWNER_PASSWORD', 'PUBLIC_URL', 'ADMIN_URL'] as const

function rejects(title: string, overrides: Environment, names: string[]) {
  test.concurrent(title, async () => {
    const { code, output } = await run({ ...env, ...overrides }).exited
    assert.equal(code, 1)
    assert.match(output, /^[^\n]+\n$/)
    assert.deepEqual([...required, 'DATA', 'AGENT_PORT', 'ADMIN_PORT'].filter((name) => output.includes(name)), names)
    assert.doesNotMatch(output, /sekret|tools\.example/)
  })
}

for (const name of required) {
  rejects(`a missing ${name} is the only variable named`, { [name]: undefined }, [name])
  rejects(`an empty ${name} is the only variable named`, { [name]: '' }, [name])
}
rejects('an empty DATA is named', { DATA: '' }, ['DATA'])
rejects('a port that is not a number is named', { AGENT_PORT: 'http' }, ['AGENT_PORT'])
rejects('a port above 65535 is named', { ADMIN_PORT: '65536' }, ['ADMIN_PORT'])
rejects(
  'all bad variables are named in one line',
  { OWNER_PASSWORD: '', PUBLIC_URL: 'sekret', ADMIN_URL: 'ftp://sekret', DATA: '' },
  [...required, 'DATA'],
)

const badUrls = [
  'not a url',
  'tools.example.com',
  'ftp://tools.example.com',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'https://tools.example.com/path',
  'https://tools.example.com//',
  'https://tools.example.com?q=1',
  'https://tools.example.com/?',
  'https://tools.example.com/#top',
  'https://user@tools.example.com',
  'https://user:sekret@tools.example.com',
]
for (const name of ['PUBLIC_URL', 'ADMIN_URL'] as const) {
  for (const url of badUrls) rejects(`${name} rejects ${url}`, { [name]: url }, [name])
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} exits 0`, async () => {
    const { child, exited } = run(env)
    onTestFinished(() => void child.kill('SIGKILL'))
    await healthy(4400, exited)
    await healthy(4401, exited)
    child.kill(signal)
    assert.deepEqual(await exited, {
      code: 0,
      signal: null,
      output: 'toolshed: agents on port 4400, admin on port 4401\n',
    })
  })
}

test('a taken port exits non-zero and names it', async () => {
  const server = createServer()
  server.listen(4401)
  await once(server, 'listening')
  onTestFinished(() => void server.close())
  const { code, output } = await run(env).exited
  assert.equal(code, 1)
  assert.match(output, /EADDRINUSE.*4401/)
  assert.doesNotMatch(output, /sekret|\n\s+at /)
})
