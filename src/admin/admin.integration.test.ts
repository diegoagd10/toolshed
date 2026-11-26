import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { text } from 'node:stream/consumers'
import { afterAll, beforeAll, onTestFinished, test } from 'vite-plus/test'
import type { Key } from '../keys/repository.js'
import type { Command } from '../store/main.js'

type Server = { agent: number, admin: number, stop: () => Promise<void> }
type Session = { cookie: string, origin: string, port: number }

const dist = join(import.meta.dirname, '../../dist')
const password = 'correct horse battery staple'
const adminUrl = 'http://admin.lan'
const hostile = '<img src=x onerror=alert(1)>'
let data = ''
let server: Server

async function startServer(env: { ADMIN_URL: string }): Promise<Server> {
  const child = spawn(process.execPath, [join(dist, 'main.js')], {
    env: {
      ...process.env,
      OWNER_PASSWORD: password,
      PUBLIC_URL: 'https://tools.example.com',
      DATA: data,
      AGENT_PORT: '0',
      ADMIN_PORT: '0',
      ...env,
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

async function store(...commands: Command[]) {
  const child = spawn(process.execPath, [join(dist, 'store.js'), data])
  child.stdin.end(commands.map((command) => `${JSON.stringify(command)}\n`)
    .join(''))
  const lines = (await text(child.stdout)).trimEnd()
    .split('\n')
  return lines.map((line) => (JSON.parse(line) as { result: unknown }).result)
}

async function keys() {
  const [listed] = await store({ do: 'key.list' })
  return listed as Key[]
}

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), 'toolshed-admin-'))
  server = await startServer({ ADMIN_URL: adminUrl })
})

afterAll(async () => {
  await server.stop()
  await rm(data, { recursive: true, force: true })
})

function get(path: string, session?: Session, port = server.admin) {
  const headers = session ? { Cookie: session.cookie } : undefined
  return fetch(`http://localhost:${session?.port ?? port}${path}`, { headers, redirect: 'manual' })
}

function post(path: string, form: string[][], session: Partial<Session> = {}) {
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
  const origin = session.origin ?? adminUrl
  if (origin) headers.set('Origin', origin)
  if (session.cookie) headers.set('Cookie', session.cookie)
  return fetch(`http://localhost:${session.port ?? server.admin}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form)
      .toString(),
    redirect: 'manual',
  })
}

async function signIn(port = server.admin, origin = adminUrl): Promise<Session> {
  const response = await post('/login', [['password', password]], { port, origin })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/')
  const cookie = String(response.headers.get('set-cookie'))
    .split(';')[0]
  return { cookie: String(cookie), origin, port }
}

async function page(path: string, session: Session) {
  const response = await get(path, session)
  assert.equal(response.status, 200)
  return response.text()
}

test('the login page loads its own CSS and script, under a strict CSP and no-store', async () => {
  const response = await get('/login')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(String(response.headers.get('content-security-policy')), /default-src 'none'; style-src 'self'; script-src 'self'/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const body = await response.text()
  assert.match(body, /<label for="password">Password<\/label>/)
  assert.ok(!/<style|<script>|style=/.test(body), 'nothing inline')
  const css = await get('/app.css')
  assert.match(String(css.headers.get('content-type')), /^text\/css/)
  assert.match(await css.text(), /prefers-color-scheme: dark/)
  const js = await get('/app.js')
  assert.match(String(js.headers.get('content-type')), /^application\/javascript|^text\/javascript/)
  assert.match(await js.text(), /clipboard/)
})

test('every page sends a visitor without a session to /login', async () => {
  for (const path of ['/', '/tools', '/keys', '/activity']) {
    const response = await get(path)
    assert.equal(response.status, 303, path)
    assert.equal(response.headers.get('location'), '/login')
  }
  const forged = await get('/', { cookie: 'toolshed_session=made-up', origin: adminUrl, port: server.admin })
  assert.equal(forged.headers.get('location'), '/login')
})

test('a wrong password gives 401, the right one a session cookie without Secure on http', async () => {
  const wrong = await post('/login', [['password', 'nope']])
  assert.equal(wrong.status, 401)
  assert.match(await wrong.text(), /role="alert">Wrong password\./)
  const empty = await post('/login', [])
  assert.equal(empty.status, 401)
  const response = await post('/login', [['password', password]])
  const cookie = String(response.headers.get('set-cookie'))
  assert.match(cookie, /^toolshed_session=[\w-]{43}; /)
  assert.ok(cookie.endsWith('; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000'), cookie)
  const session = await signIn()
  const login = await get('/login', session)
  assert.equal(login.headers.get('location'), '/')
})

test('a POST from another origin, or with no Origin, is refused', async () => {
  for (const origin of ['https://evil.example', '']) {
    const response = await post('/login', [['password', password]], { origin })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

test('empty Keys, Activity and Start pages say so', async () => {
  const session = await signIn()
  assert.match(await page('/keys', session), /No keys yet\./)
  assert.match(await page('/activity', session), /No calls yet\./)
  const start = await page('/', session)
  assert.match(start, /0 keys are active\./)
  assert.match(start, /No calls yet\./)
  assert.ok(start.includes('<pre id="setup">set up toolshed: https://tools.example.com/llms.txt</pre>'))
  assert.match(start, /<pre id="mcp">https:\/\/tools\.example\.com\/mcp<\/pre>/)
})

test('Tools lists every tool by id', async () => {
  const body = await page('/tools', await signIn())
  for (const id of ['qr.create', 'pdf.merge', 'pdf.split']) assert.match(body, new RegExp(`<pre>${id} \\{`))
  assert.match(body, /aria-current="page">Tools/)
})

test('a new key is shown once, works on the agent port and is gone after a reload', async () => {
  const session = await signIn()
  const created = await post('/keys', [['name', 'laptop agent']], session)
  assert.equal(created.status, 303)
  assert.equal(created.headers.get('location'), '/keys')
  const first = await page('/keys', session)
  const secret = /<pre id="new-key">(ts_[\w-]+)<\/pre>/.exec(first)?.[1] ?? ''
  assert.match(first, /<h2>Key for laptop agent<\/h2>/)
  const me = await fetch(`http://localhost:${server.agent}/v1/me`, { headers: { Authorization: `Bearer ${secret}` } })
  assert.equal(((await me.json()) as { name: string }).name, 'laptop agent')
  const again = await page('/keys', session)
  assert.ok(!again.includes(secret))
  assert.ok(!again.includes('new-key'))
  assert.match(again, new RegExp(`<code>${secret.slice(0, 9)}…</code>`))
  assert.match(await page('/', session), /1 key is active\./)
})

test('another session never sees the new key', async () => {
  const owner = await signIn()
  const other = await signIn()
  await post('/keys', [['name', 'second agent']], owner)
  assert.ok(!(await page('/keys', other)).includes('new-key'))
  assert.match(await page('/keys', owner), /new-key/)
})

test('a key named like HTML shows as text, in the page and in attributes', async () => {
  const session = await signIn()
  await post('/keys', [['name', hostile]], session)
  await post('/keys', [['name', 'say "hi" \' `x`']], session)
  const body = await page('/keys', session)
  assert.ok(!body.includes(hostile))
  assert.match(body, /<td data-label="Name">&#60;img src=x onerror=alert\(1\)&#62;<\/td>/)
  assert.match(body, /aria-label="Revoke say &#34;hi&#34; &#39; &#96;x&#96;"/)
  assert.match(body, /<h2>Key for say &#34;hi&#34; &#39; &#96;x&#96;<\/h2>/)
})

test('a key name must have 1 to 60 characters', async () => {
  const session = await signIn()
  const before = (await keys()).length
  for (const name of ['   ', 'x'.repeat(61)]) {
    const response = await post('/keys', [['name', name]], session)
    assert.equal(response.status, 422)
    assert.match(await response.text(), /role="alert">Give the key a name of 1 to 60 characters\./)
  }
  assert.equal((await keys()).length, before)
})

test('creating or revoking from another origin or without a session changes nothing', async () => {
  const session = await signIn()
  const before = await keys()
  const target = before.find((key) => key.name === 'laptop agent')
  const attempts = [
    post('/keys', [['name', 'forged']], { ...session, origin: 'https://evil.example' }),
    post('/keys', [['name', 'forged']], { origin: adminUrl }),
    post(`/keys/${target?.id}/revoke`, [], { ...session, origin: 'https://evil.example' }),
    post(`/keys/${target?.id}/revoke`, [], { origin: adminUrl }),
  ]
  const statuses = (await Promise.all(attempts)).map((response) => response.status)
  assert.deepEqual(statuses, [403, 303, 403, 303])
  assert.deepEqual(await keys(), before)
})

test('revoking a key stops it on the agent port at once', async () => {
  const session = await signIn()
  await post('/keys', [['name', 'to revoke']], session)
  const secret = /<pre id="new-key">(ts_[\w-]+)<\/pre>/.exec(await page('/keys', session))?.[1]
  const key = (await keys()).find(({ name }) => name === 'to revoke')
  const response = await post(`/keys/${key?.id}/revoke`, [], session)
  assert.equal(response.headers.get('location'), '/keys')
  const me = await fetch(`http://localhost:${server.agent}/v1/me`, { headers: { Authorization: `Bearer ${secret}` } })
  assert.equal(me.status, 401)
  assert.match(await page('/keys', session), /<td data-label="Name">to revoke<\/td>[\s\S]*?<span class="muted">revoked<\/span>/)
})

test('Activity and Start show calls with the name of their key', async () => {
  const session = await signIn()
  await post('/keys', [['name', 'busy agent']], session)
  const secret = /<pre id="new-key">(ts_[\w-]+)<\/pre>/.exec(await page('/keys', session))?.[1]
  const call = (tool: string, body: object) => fetch(`http://localhost:${server.agent}/v1/call/${tool}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal((await call('qr.create', { text: 'hi' })).status, 200)
  assert.equal((await call('pdf.split', { file: 'file_missing', ranges: ['1'] })).status, 404)
  const body = await page('/activity', session)
  const rows = body.split('<tr>')
    .slice(2)
  assert.match(String(rows[0]), /pdf\.split[\s\S]*>busy agent<[\s\S]*>rest</)
  assert.match(String(rows[0]), /class="error">file_not_found</)
  assert.match(String(rows[1]), /qr\.create[\s\S]*>busy agent<[\s\S]*>rest<[\s\S]*class="ok">ok</)
  assert.match(await page('/', session), /Last call: <code>pdf\.split<\/code> <time datetime="/)
  const used = await page('/keys', session)
  const row = used.split('<tr>')
    .find((part) => part.includes('>busy agent<'))
  assert.match(String(row), /<td data-label="Last used"><time datetime="\d{4}-/)
})

test('signing out ends the session', async () => {
  const session = await signIn()
  const refused = await post('/logout', [], { ...session, origin: 'https://evil.example' })
  assert.equal(refused.status, 403)
  assert.equal((await get('/', session)).status, 200)
  const response = await post('/logout', [], session)
  assert.equal(response.headers.get('location'), '/login')
  assert.match(String(response.headers.get('set-cookie')), /^toolshed_session=; .*Max-Age=0$/)
  assert.equal((await get('/', session)).headers.get('location'), '/login')
})

test('the agent port has no dashboard pages', async () => {
  for (const path of ['/', '/login', '/keys', '/activity', '/tools', '/app.css']) {
    assert.equal((await get(path, undefined, server.agent)).status, 404, path)
  }
})

test('with an https ADMIN_URL the cookie is Secure, and the sixth wrong password in a minute gives 429', async () => {
  const origin = 'https://admin.example.com'
  const secure = await startServer({ ADMIN_URL: origin })
  onTestFinished(() => secure.stop())
  const signedIn = await post('/login', [['password', password]], { port: secure.admin, origin })
  assert.match(String(signedIn.headers.get('set-cookie')), /; Secure$/)
  const wrong = []
  for (let attempt = 0; attempt < 6; attempt++) {
    wrong.push((await post('/login', [['password', 'nope']], { port: secure.admin, origin })).status)
  }
  assert.deepEqual(wrong, [401, 401, 401, 401, 401, 429])
  const locked = await post('/login', [['password', password]], { port: secure.admin, origin })
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers.get('retry-after')) <= 60)
  assert.match(await locked.text(), /Too many wrong passwords\. Try again in \d+ s\./)
  assert.equal(locked.headers.get('set-cookie'), null)
})
