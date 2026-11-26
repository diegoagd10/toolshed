import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { text } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, onTestFinished, test } from 'vite-plus/test'
import type { Key } from '../keys/repository.js'
import type { Command } from '../store/main.js'

type Server = { agent: number, admin: number, stop: () => Promise<void> }
type Started = { pair_id: string, code: string, expires_at: string, message: string }
type Body = { key?: string, name?: string, status?: string, error?: { code: string } }
type Answer = { status: number, body: Body }

const dist = join(import.meta.dirname, '../../dist')
const password = 'owner password'
const adminUrl = 'http://admin.lan'
let data = ''
let server: Server
let cookie = ''

async function startServer(): Promise<Server> {
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    env: {
      ...process.env,
      OWNER_PASSWORD: password,
      PUBLIC_URL: 'https://tools.example.com',
      ADMIN_URL: adminUrl,
      DATA: data,
      AGENT_PORT: '0',
      ADMIN_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const [line = ''] = await once(createInterface({ input: child.stdout }), 'line') as string[]
  const [, agent, admin] = /agents on port (\d+), admin on port (\d+)/.exec(line) ?? []
  const exited = once(child, 'exit')
  // SIGTERM lets the server close and write its coverage.
  const stop = async () => {
    child.kill('SIGTERM')
    await exited
  }
  return { agent: Number(agent), admin: Number(admin), stop }
}

async function keys() {
  const child = spawn(process.execPath, [join(dist, 'store.js'), data])
  child.stdin.end(`${JSON.stringify({ do: 'key.list' } satisfies Command)}\n`)
  return (JSON.parse(await text(child.stdout)) as { result: Key[] }).result
}

function form(port: number, path: string, fields: string[][], origin = adminUrl, session = cookie) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': origin, 'Cookie': session },
    body: new URLSearchParams(fields)
      .toString(),
    redirect: 'manual',
  })
}

async function signIn(at: Server) {
  const response = await form(at.admin, '/login', [['password', password]], adminUrl, '')
  return String(response.headers.get('set-cookie'))
    .split(';')[0]
}

async function dashboard(path: string, at = server, session = cookie) {
  const response = await fetch(`http://localhost:${at.admin}${path}`, { headers: { Cookie: session } })
  assert.equal(response.status, 200)
  return response.text()
}

function approve(code: string, at = server, session = cookie) {
  return form(at.admin, '/pair/approve', [['code', code]], adminUrl, session)
}

function json(port: number, path: string, body: unknown) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function start(agent: string, at = server) {
  const response = await json(at.agent, '/pair', { agent })
  assert.equal(response.status, 200)
  return (await response.json()) as Started
}

async function claim(pairId: string, wait?: number, at = server): Promise<Answer> {
  const response = await json(at.agent, '/pair/token', { pair_id: pairId, wait })
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'toolshed-pair-'))
  server = await startServer()
  cookie = String(await signIn(server))
})

afterAll(async () => {
  await server.stop()
  await rm(data, { recursive: true, force: true })
})

test('POST /pair returns a private pair_id and a short code for the owner', async () => {
  const started = await start('Claude Code')
  assert.match(started.pair_id, /^pair_[\w-]{32}$/)
  assert.match(started.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/)
  assert.ok(Date.parse(started.expires_at) - Date.now() > 9 * 60_000)
  assert.ok(started.message.includes(`Type the code ${started.code} on the Start page`))
  for (const body of [{}, { agent: ' ' }, { agent: 'x'.repeat(61) }, { agent: 'a', extra: 1 }]) {
    assert.equal((await json(server.agent, '/pair', body)).status, 422)
  }
})

test('before the owner types the code the token request is pending, and an unknown pair is 404', async () => {
  const { pair_id: id } = await start('patient agent')
  assert.deepEqual((await claim(id, 0)).body.status, 'pending')
  assert.equal((await claim(id, 0)).status, 202)
  const unknown = await claim('pair_nope', 0)
  assert.deepEqual([unknown.status, unknown.body.error?.code], [404, 'pair_not_found'])
  for (const body of [{}, { pair_id: id, wait: 26 }, { pair_id: id, wait: 1.5 }]) {
    assert.equal((await json(server.agent, '/pair/token', body)).status, 422)
  }
})

test('the waiting request returns the key as soon as the owner types the code, once', async () => {
  const { pair_id: id, code } = await start('Codex')
  const started = performance.now()
  const waiting = claim(id)
  await sleep(300)
  // The owner may type it in lowercase and without the dash.
  const approved = await approve(code.toLowerCase()
    .replace('-', ''))
  assert.equal(approved.status, 303)
  assert.equal(approved.headers.get('location'), '/')
  const answer = await waiting
  assert.ok(performance.now() - started < 3_000, 'the server answered when the code was typed')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.name, 'Codex')
  const me = await fetch(`http://localhost:${server.agent}/v1/me`, { headers: { Authorization: `Bearer ${answer.body.key}` } })
  assert.equal(((await me.json()) as { name: string }).name, 'Codex')
  assert.match(await dashboard('/'), /role="status">Approved Codex\. It gets its own key now\./)
  assert.ok(!(await dashboard('/')).includes('Approved Codex'))
  const used = await claim(id, 0)
  assert.deepEqual([used.status, used.body.error?.code], [404, 'pair_not_found'])
})

test('two claims at once deliver a single key', async () => {
  const { pair_id: id, code } = await start('twin agent')
  const before = (await keys()).length
  const claims = [claim(id), claim(id)]
  await sleep(300)
  await approve(code)
  const statuses = (await Promise.all(claims)).map(({ status }) => status)
    .sort((x, y) => x - y)
  assert.deepEqual(statuses, [200, 404])
  assert.equal((await keys()).length, before + 1)
})

test('the dashboard never shows a pending code', async () => {
  const { code } = await start('hidden agent')
  const plain = code.replace('-', '')
  for (const path of ['/', '/keys', '/activity', '/tools']) {
    const body = await dashboard(path)
    assert.ok(!body.includes(code) && !body.includes(plain), `${path} shows the code`)
    assert.ok(!body.includes('hidden agent'), `${path} shows the agent`)
  }
})

test('a code is approved once, a wrong one says so, and another origin changes nothing', async () => {
  const { pair_id: id, code } = await start('careful agent')
  const forged = await form(server.admin, '/pair/approve', [['code', code]], 'https://evil.example')
  assert.equal(forged.status, 403)
  const anonymous = await form(server.admin, '/pair/approve', [['code', code]], adminUrl, '')
  assert.equal(anonymous.headers.get('location'), '/login')
  assert.equal((await claim(id, 0)).status, 202)
  assert.equal((await approve(code)).status, 303)
  const twice = await approve(code)
  assert.equal(twice.status, 422)
  assert.match(await twice.text(), /role="alert">No agent is waiting with that code\./)
  assert.equal((await claim(id, 0)).status, 200)
})

test('six wrong codes in a minute block the seventh attempt, even with the right code', async () => {
  const other = await startServer()
  onTestFinished(() => other.stop())
  const session = String(await signIn(other))
  const { pair_id: id, code } = await start('locked out agent', other)
  const statuses = []
  for (let attempt = 0; attempt < 6; attempt++) statuses.push((await approve('WRON-GCOD', other, session)).status)
  assert.deepEqual(statuses, [422, 422, 422, 422, 422, 422])
  const blocked = await approve(code, other, session)
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) <= 60)
  assert.match(await blocked.text(), /Too many wrong codes\. Try again in \d+ s\./)
  assert.equal((await claim(id, 0, other)).status, 202)
  assert.ok(!(await dashboard('/', other, session)).includes(code))
})

test('at most 20 agents wait for the owner at once', async () => {
  const other = await startServer()
  onTestFinished(() => other.stop())
  for (let agent = 0; agent < 20; agent++) await start(`agent ${agent}`, other)
  const refused = await json(other.agent, '/pair', { agent: 'one too many' })
  assert.equal(refused.status, 429)
  assert.equal(refused.headers.get('retry-after'), '60')
  assert.equal(((await refused.json()) as Answer['body']).error?.code, 'too_many_pairs')
})

test('SIGTERM does not wait for a token request that is still holding', async () => {
  const other = await startServer()
  const { pair_id: id } = await start('sleepy agent', other)
  const holding = claim(id, 25, other)
    .catch(() => 'cut')
  await sleep(200)
  const started = performance.now()
  await other.stop()
  assert.ok(performance.now() - started < 2_000)
  assert.equal(await holding, 'cut')
})
