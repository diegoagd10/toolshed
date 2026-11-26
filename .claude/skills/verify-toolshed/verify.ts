#!/usr/bin/env node
// Drives a toolshed instance that this run started. See SKILL.md next to this file.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Page } from 'playwright-core'

type State = {
  run: string
  pid: number
  agentPort: number
  adminPort: number
  data: string
  password: string
  evidence: string
  key?: string
}

const repo = resolve(import.meta.dirname, '../../..')
const [command = 'help', ...args] = process.argv.slice(2)
const run = process.env.VERIFY_RUN ?? 'default'
const scratch = join(tmpdir(), `toolshed-verify-${run}`)
const stateFile = join(scratch, 'state.json')
// Evidence lives in the repo, outside the scratch folder, so cleanup never removes it.
const evidence = join(repo, 'verify-evidence', run)

function fail(message: string): never {
  console.error(`verify: ${message}`)
  process.exit(1)
}

function readState(): State {
  if (!existsSync(stateFile)) fail(`no instance for VERIFY_RUN=${run}; run launch first`)
  return JSON.parse(readFileSync(stateFile, 'utf8')) as State
}

function alive(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .includes('dist/main.js')
  } catch {
    return false
  }
}

async function health(port: number) {
  try {
    return (await fetch(`http://localhost:${port}/health`)).status
  } catch {
    return 0
  }
}

async function newestSource(dir: string): Promise<number> {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, await newestSource(path))
    else if (!entry.name.endsWith('.test.ts')) newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

async function launch() {
  if (existsSync(stateFile) && alive(readState().pid)) fail(`VERIFY_RUN=${run} is already running; stop it first`)
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'ignore' })
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(join(scratch, 'data'), { recursive: true })
  mkdirSync(evidence, { recursive: true })
  const password = `verify-${Math.random()
    .toString(36)
    .slice(2)}`
  // Free ports, so runs never collide with each other or with npm start.
  const [agentPort, adminPort] = [await freePort(), await freePort()]
  const state: State = { run, pid: 0, agentPort, adminPort, data: join(scratch, 'data'), password, evidence }
  const log = openSync(join(scratch, 'server.log'), 'w')
  const child = spawn(process.execPath, ['--max-semi-space-size=1', 'dist/main.js'], {
    cwd: repo,
    env: {
      ...process.env,
      OWNER_PASSWORD: password,
      PUBLIC_URL: `http://localhost:${agentPort}`,
      ADMIN_URL: `http://localhost:${adminPort}`,
      DATA: state.data,
      AGENT_PORT: String(agentPort),
      ADMIN_PORT: String(adminPort),
    },
    stdio: ['ignore', log, log],
    detached: true,
  })
  child.unref()
  state.pid = Number(child.pid)
  const deadline = performance.now() + 15_000
  while ((await health(agentPort)) !== 200 || (await health(adminPort)) !== 200) {
    if (performance.now() > deadline || !alive(state.pid)) {
      fail(`the server did not start; see ${join(scratch, 'server.log')}`)
    }
    await sleep(100)
  }
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log(`ready: agents http://localhost:${state.agentPort}, admin http://localhost:${state.adminPort}`)
  console.log(`evidence: ${evidence}`)
}

async function doctor() {
  const state = readState()
  const checks: [string, boolean][] = [
    [`process ${state.pid} runs dist/main.js`, alive(state.pid)],
    [`agent port ${state.agentPort} /health is 200`, (await health(state.agentPort)) === 200],
    [`admin port ${state.adminPort} /health is 200`, (await health(state.adminPort)) === 200],
  ]
  const built = statSync(join(repo, 'dist/main.js')).mtimeMs
  checks.push(['dist/ is newer than src/', built >= await newestSource(join(repo, 'src'))])
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  console.log(`commit ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    .trim()}, data ${state.data}`)
  if (checks.some(([, ok]) => !ok)) process.exit(1)
}

function key() {
  const state = readState()
  const name = args[0] ?? 'verify agent'
  const output = execFileSync(process.execPath, [join(repo, 'dist/store.js'), state.data], {
    input: `${JSON.stringify({ do: 'key.create', name })}\n`,
    encoding: 'utf8',
  })
  state.key = (JSON.parse(output) as { result: { secret: string } }).result.secret
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log(`key "${name}" saved in ${stateFile}; it is never printed`)
}

function base(state: State, url: string) {
  if (url.startsWith('http')) return url
  const [port, path] = url.startsWith('agent:')
    ? [state.agentPort, url.slice(6)]
    : [state.adminPort, url.replace(/^admin:/, '')]
  return `http://localhost:${port}${path}`
}

async function signIn(page: Page, state: State) {
  await page.goto(base(state, 'admin:/login'))
  await page.getByLabel('Password')
    .fill(state.password)
  await page.getByRole('button', { name: 'Sign in' })
    .click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

// shot <url> <name> [--width N] [--owner]: a full-page screenshot, its ARIA snapshot and the
// response status. <url> is admin:/path, agent:/path or a full URL.
async function shot() {
  const state = readState()
  const [url = '', name = ''] = args
  if (!url || !name) fail('usage: shot <admin:/path|agent:/path> <name> [--width N] [--owner]')
  const width = Number(args[args.indexOf('--width') + 1]) || 1200
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    if (args.includes('--owner')) await signIn(page, state)
    const response = await page.goto(base(state, url))
    const status = response?.status() ?? 0
    const scroll = await page.evaluate(() => {
      const { scrollWidth, clientWidth } = document.documentElement
      return scrollWidth > clientWidth
    })
    const file = join(evidence, `${name}-${width}`)
    await page.screenshot({ path: `${file}.png`, fullPage: true })
    writeFileSync(`${file}.aria.txt`, await page.locator('body')
      .ariaSnapshot())
    console.log(`${url} at ${width} px: HTTP ${status}, horizontal scroll ${scroll ? 'YES' : 'no'} -> ${file}.png`)
  } finally {
    await browser.close()
  }
}

// call <tool> '<json>': POST /v1/call/<tool> with the key from `key`, as an agent would.
async function call() {
  const state = readState()
  const [tool = '', input = '{}'] = args
  if (!state.key) fail('no key yet; run key first')
  const response = await fetch(base(state, `agent:/v1/call/${tool}`), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.key}`, 'Content-Type': 'application/json' },
    body: input,
  })
  console.log(`HTTP ${response.status} ${await response.text()}`)
}

async function capture(page: Page, name: string) {
  const width = page.viewportSize()?.width ?? 0
  const file = join(evidence, `${name}-${width}`)
  await page.screenshot({ path: `${file}.png`, fullPage: true })
  writeFileSync(`${file}.aria.txt`, await page.locator('body')
    .ariaSnapshot())
  console.log(`   captured ${file}.png`)
}

function check(ok: boolean, message: string) {
  if (!ok) fail(`journey failed: ${message}`)
  console.log(`ok ${message}`)
}

// journey keys [--width N]: create a key in the UI, copy it, reload, revoke it, and prove each
// step on the agent port too. The secret is masked in the captures.
async function journeyKeys() {
  const state = readState()
  const width = Number(args[args.indexOf('--width') + 1]) || 1200
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await context.newPage()
    await signIn(page, state)
    await page.getByRole('link', { name: 'Keys' })
      .click()
    const name = `journey ${Date.now()}`
    await page.getByLabel('Agent name')
      .fill(name)
    await page.getByRole('button', { name: 'Create key' })
      .click()
    const secret = String(await page.locator('#new-key')
      .textContent())
    await page.getByRole('button', { name: 'Copy', exact: true })
      .click()
    check(await page.evaluate(() => navigator.clipboard.readText()) === secret, 'Copy puts the new key on the clipboard')
    const me = async () => (await fetch(base(state, 'agent:/v1/me'), {
      headers: { Authorization: `Bearer ${secret}` },
    })).status
    check(await me() === 200, 'the new key works on the agent port (/v1/me 200)')
    await page.locator('#new-key')
      .evaluate((element, shown) => {
        element.textContent = `${shown}… (masked in this capture)`
      }, secret.slice(0, 9))
    await capture(page, 'journey-keys-1-created')
    await page.reload()
    check(!(await page.content()).includes(secret), 'after a reload the key is not in the page')
    await capture(page, 'journey-keys-2-reloaded')
    await page.getByRole('button', { name: `Revoke ${name}` })
      .click()
    await page.waitForURL(base(state, 'admin:/keys'))
    const row = page.getByRole('row', { name: new RegExp(name) })
    check(await row.getByText('revoked')
      .count() === 1, 'the row says revoked')
    check(await me() === 401, 'the revoked key gets 401 on the agent port')
    await capture(page, 'journey-keys-3-revoked')
  } finally {
    await browser.close()
  }
}

// journey pair [--width N]: an agent starts pairing over HTTP, the owner types its code on Start,
// and the agent's waiting request returns a key that works.
async function journeyPair() {
  const state = readState()
  const width = Number(args[args.indexOf('--width') + 1]) || 1200
  const post = (path: string, body: unknown) => fetch(base(state, `agent:${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    await signIn(page, state)
    const started = (await (await post('/pair', { agent: 'journey agent' })).json()) as { pair_id: string, code: string }
    check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(started.code), `POST /pair gives a code (${started.code})`)
    check(!(await page.content()).includes(started.code), 'Start does not show the pending code')
    await page.getByLabel('Code')
      .fill('WRON-GCOD')
    await page.getByRole('button', { name: 'Approve' })
      .click()
    check(await page.getByRole('alert')
      .count() === 1, 'a wrong code says no agent is waiting')
    await capture(page, 'journey-pair-1-wrong-code')
    const waiting = post('/pair/token', { pair_id: started.pair_id })
    await page.getByLabel('Code')
      .fill(started.code)
    await page.getByRole('button', { name: 'Approve' })
      .click()
    await page.waitForURL(base(state, 'admin:/'))
    const answer = await waiting
    const { key } = (await answer.json()) as { key: string }
    check(answer.status === 200, 'the waiting /pair/token returns 200 with a key')
    const me = await fetch(base(state, 'agent:/v1/me'), { headers: { Authorization: `Bearer ${key}` } })
    check(me.status === 200, 'the key works on /v1/me')
    await capture(page, 'journey-pair-2-approved')
  } finally {
    await browser.close()
  }
}

function journey() {
  const [name] = args
  if (name === 'pair') return journeyPair()
  if (name !== 'keys') fail('usage: journey keys|pair [--width N]')
  return journeyKeys()
}

function stop() {
  if (!existsSync(stateFile)) {
    console.log(`nothing to stop for VERIFY_RUN=${run}`)
    return
  }
  const { pid } = readState()
  // Kill only the process this run started, never by name.
  if (alive(pid)) process.kill(pid, 'SIGTERM')
  rmSync(scratch, { recursive: true, force: true })
  console.log(`stopped ${pid}; evidence kept in ${evidence}`)
}

const commands = { launch, doctor, key, call, shot, journey, stop }
const chosen = commands[command as keyof typeof commands] as (() => unknown) | undefined
if (!chosen) {
  console.log('usage: VERIFY_RUN=<id> .claude/skills/verify-toolshed/verify.ts launch|doctor|key [name]|call <tool> <json>|shot <url> <name> [--width N] [--owner]|journey keys|pair [--width N]|stop')
  process.exit(command === 'help' ? 0 : 1)
}
await chosen()
