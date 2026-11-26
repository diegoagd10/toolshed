import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-admin-live-'))
const password = 'live-check-password'
const hostile = '<img src=x onerror=alert(1)>'

async function freePort() {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, done))
  const { port } = probe.address() as { port: number }
  await new Promise((done) => probe.close(done))
  return port
}

const [agentPort, adminPort] = [await freePort(), await freePort()]
const admin = `http://localhost:${adminPort}`
const agent = `http://localhost:${agentPort}`
const server = spawn(process.execPath, ['--max-semi-space-size=1', join(dist, 'main.js')], {
  env: {
    ...process.env,
    OWNER_PASSWORD: password,
    PUBLIC_URL: agent,
    ADMIN_URL: admin,
    DATA: dir,
    AGENT_PORT: String(agentPort),
    ADMIN_PORT: String(adminPort),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const browser = await chromium.launch()
process.on('exit', () => {
  server.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})
while (await fetch(`${admin}/health`)
  .then(() => false, () => true)) await sleep(50)

function storeKeys() {
  const output = execFileSync(process.execPath, [join(dist, 'store.js'), dir], {
    input: `${JSON.stringify({ do: 'key.list' })}\n`,
    encoding: 'utf8',
  })
  return (JSON.parse(output) as { result: { name: string, revokedAt: string | null }[] }).result
}

async function me(secret: string) {
  return (await fetch(`${agent}/v1/me`, { headers: { Authorization: `Bearer ${secret}` } })).status
}

const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const dialogs: string[] = []
page.on('dialog', (dialog) => {
  dialogs.push(dialog.message())
  void dialog.dismiss()
})

async function signIn() {
  await page.goto(`${admin}/`)
  assert.equal(new URL(page.url()).pathname, '/login')
  await page.getByLabel('Password')
    .fill(password)
  await page.getByRole('button', { name: 'Sign in' })
    .click()
  await page.waitForURL(`${admin}/`)
  console.log('ok login: / sends to /login, the password signs in and lands on Start')
}

async function createCopyReloadRevoke() {
  await page.getByRole('link', { name: 'Keys' })
    .click()
  await page.getByLabel('Agent name')
    .fill('Claude Code')
  await page.getByRole('button', { name: 'Create key' })
    .click()
  const secret = String(await page.locator('#new-key')
    .textContent())
  await page.getByRole('button', { name: 'Copy', exact: true })
    .click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), secret)
  assert.equal(await me(secret), 200)
  console.log('ok create and copy: the clipboard holds the key, and /v1/me with it gives 200')
  const reloaded = await page.reload()
  assert.equal(reloaded?.headers()['cache-control'], 'no-store')
  assert.ok(!(await page.content()).includes(secret))
  assert.equal(await page.locator('#new-key')
    .count(), 0)
  console.log('ok reload: the key is not in the page any more; Cache-Control: no-store')
  await page.getByRole('button', { name: 'Revoke Claude Code' })
    .click()
  await page.waitForURL(`${admin}/keys`)
  assert.equal(await page.getByRole('row', { name: /Claude Code/ })
    .getByText('revoked')
    .count(), 1)
  assert.equal(await me(secret), 401)
  console.log('ok revoke: the row says revoked, and /v1/me with the key gives 401')
}

async function hostileName() {
  await page.getByLabel('Agent name')
    .fill(hostile)
  await page.getByRole('button', { name: 'Create key' })
    .click()
  await page.waitForLoadState('load')
  await sleep(300)
  assert.equal(await page.getByRole('cell', { name: hostile, exact: true })
    .count(), 1)
  assert.equal(await page.locator('main img')
    .count(), 0)
  assert.deepEqual(dialogs, [])
  console.log(`ok a key named ${hostile} shows as text: no img element, no alert`)
}

async function crossOrigin() {
  const before = storeKeys().length
  // A page on the agent port is another origin with the same site, so the browser sends the cookie.
  const other = await context.newPage()
  await other.goto(`${agent}/llms.txt`)
  const answer = other.waitForResponse(`${admin}/keys`)
  await other.evaluate((target) => {
    const form = document.createElement('form')
    form.method = 'post'
    form.action = target
    const input = document.createElement('input')
    input.name = 'name'
    input.value = 'forged'
    form.append(input)
    document.body.append(form)
    form.submit()
  }, `${admin}/keys`)
  const status = (await answer).status()
  assert.equal(status, 403)
  assert.equal(storeKeys().length, before)
  const noCookie = await fetch(`${admin}/keys`, {
    method: 'POST',
    headers: { 'Origin': admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=forged',
    redirect: 'manual',
  })
  assert.equal(noCookie.status, 303)
  assert.equal(storeKeys().length, before)
  await other.close()
  console.log(`ok a form posted from ${agent} gets ${status}, a POST without cookie gets 303 to /login; no key was made`)
}

async function agentPort404() {
  const statuses = []
  for (const path of ['/', '/keys', '/activity', '/login']) {
    statuses.push(`${path} ${(await fetch(`${agent}${path}`)).status}`)
  }
  assert.ok(statuses.every((line) => line.endsWith(' 404')))
  console.log(`ok on the agent port: ${statuses.join(', ')}`)
}

async function widths() {
  for (const width of [390, 1200]) {
    await page.setViewportSize({ width, height: 800 })
    for (const path of ['/', '/tools', '/keys', '/activity']) {
      await page.goto(`${admin}${path}`)
      const scroll = await page.evaluate(() => {
        const { scrollWidth, clientWidth } = document.documentElement
        return scrollWidth > clientWidth
      })
      assert.ok(!scroll, `${path} scrolls sideways at ${width} px`)
    }
  }
  console.log('ok Start, Tools, Keys and Activity have no horizontal scroll at 390 and 1200 px')
}

async function perf() {
  const commands = Array.from({ length: 20 - storeKeys().length }, (_, index) => JSON.stringify({ do: 'key.create', name: `agent ${index + 1}` }))
  execFileSync(process.execPath, [join(dist, 'store.js'), dir], { input: `${commands.join('\n')}\n` })
  assert.equal(storeKeys().length, 20)
  const times: number[] = []
  for (let visit = 0; visit < 10; visit++) {
    await page.goto(`${admin}/keys`)
    times.push(await page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
      return Math.round(Number(navigation?.loadEventEnd) - Number(navigation?.startTime))
    }))
  }
  console.log(`/keys with 20 keys, 10 visits: ${times.join(', ')} ms`)
  times.sort((x, y) => x - y)
  console.log(`median ${times[5]} ms [${times[0]}-${times[9]}]`)
  assert.ok((times[9] ?? Infinity) <= 100, 'the limit is 100 ms')
  console.log('ok every visit loaded in 100 ms or less')
}

await signIn()
await createCopyReloadRevoke()
await hostileName()
await crossOrigin()
await agentPort404()
await widths()
await perf()
await browser.close()
server.kill('SIGTERM')
await once(server, 'exit')
