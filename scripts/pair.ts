// Live checks for pairing. Usage:
//   node scripts/pair.ts claude 5   Claude Code, curl only, connects and makes a QR, 5 times
//   node scripts/pair.ts codex 1    the same with Codex
//   node scripts/pair.ts checks     /health while 20 requests wait, and 6 wrong codes
// Transcripts, with keys masked, go to $PAIR_EVIDENCE (default: a temporary folder).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Page } from 'playwright-core'

const dist = join(import.meta.dirname, '../dist')
const dir = mkdtempSync(join(tmpdir(), 'toolshed-pair-live-'))
const evidence = process.env.PAIR_EVIDENCE ?? join(dir, 'evidence')
mkdirSync(evidence, { recursive: true })
const password = 'live-check-password'
const codePattern = /\b[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}\b/
const [mode = 'checks', count = '1'] = process.argv.slice(2)

async function freePort() {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, done))
  const { port } = probe.address() as { port: number }
  await new Promise((done) => probe.close(done))
  return port
}

const [agentPort, adminPort] = [await freePort(), await freePort()]
const agentUrl = `http://localhost:${agentPort}`
const adminUrl = `http://localhost:${adminPort}`
const server = spawn(process.execPath, ['--max-semi-space-size=1', join(dist, 'main.js')], {
  env: {
    ...process.env,
    OWNER_PASSWORD: password,
    PUBLIC_URL: agentUrl,
    ADMIN_URL: adminUrl,
    DATA: join(dir, 'data'),
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
while (await fetch(`${adminUrl}/health`)
  .then(() => false, () => true)) await sleep(50)

function keyCount() {
  const output = execFileSync(process.execPath, [join(dist, 'store.js'), join(dir, 'data')], {
    input: `${JSON.stringify({ do: 'key.list' })}\n`,
    encoding: 'utf8',
  })
  return (JSON.parse(output) as { result: unknown[] }).result.length
}

// The owner: signed in on the dashboard, typing the code the agent shows.
async function owner() {
  const page = await browser.newPage()
  await page.goto(`${adminUrl}/login`)
  await page.getByLabel('Password')
    .fill(password)
  await page.getByRole('button', { name: 'Sign in' })
    .click()
  await page.waitForURL(`${adminUrl}/`)
  return page
}

async function typeCode(page: Page, code: string) {
  await page.goto(`${adminUrl}/`)
  await page.getByLabel('Code')
    .fill(code)
  await page.getByRole('button', { name: 'Approve' })
    .click()
  await page.waitForLoadState('load')
  return String(await page.getByRole('status')
    .or(page.getByRole('alert'))
    .first()
    .textContent())
}

function command(agent: string, prompt: string, cwd: string): [string, string[]] {
  if (agent === 'claude') {
    return ['claude', ['-p', prompt, '--allowedTools', 'Bash(curl:*)', '--strict-mcp-config', '--output-format', 'stream-json', '--verbose']]
  }
  return ['codex', ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', prompt]]
}

// A message from the agent to the human, not a command or its output.
function toldTheOwner(agent: string, line: string) {
  return agent === 'claude' ? /"type":"text"/.test(line) && !/"tool_result"/.test(line) : /"agent_message"/.test(line)
}

async function attempt(agent: string, round: number, page: Page) {
  const work = join(dir, `${agent}-${round}`)
  mkdirSync(work)
  const prompt = `set up toolshed: ${agentUrl}/llms.txt\n\nThen make a QR code for the text "toolshed works" and save it in this folder as qr.png.`
  const [program, args] = command(agent, prompt, work)
  const before = keyCount()
  const started = performance.now()
  const child = spawn(program, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines: string[] = []
  const approvals: string[] = []
  createInterface({ input: child.stderr })
    .on('line', (line) => lines.push(`[stderr] ${line}`))
  for await (const line of createInterface({ input: child.stdout })) {
    lines.push(line)
    // The owner reads only what the agent tells them, as in a chat.
    const code = toldTheOwner(agent, line) ? codePattern.exec(line)?.[0] : undefined
    if (!code || approvals.includes(code)) continue
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    approvals.push(code)
    console.log(`   ${seconds} s: the agent told the owner ${code}; the owner types it: ${await typeCode(page, code)}`)
  }
  const [exit] = await once(child, 'close') as [number]
  const seconds = (performance.now() - started) / 1000
  writeFileSync(join(evidence, `${agent}-${round}.jsonl`), lines.join('\n')
    .replace(/ts_[\w-]{20,}/g, 'ts_<masked>'))
  const qr = join(work, 'qr.png')
  const decoded = existsSync(qr) ? execFileSync('zbarimg', ['-q', '--raw', qr], { encoding: 'utf8' })
    .trim() : '(no qr.png)'
  const ok = exit === 0 && decoded === 'toolshed works' && approvals.length === 1 && keyCount() === before + 1 && seconds < 60
  console.log(`${ok ? 'ok' : 'FAIL'} ${agent} ${round}: ${seconds.toFixed(1)} s, ${approvals.length} approval, ${keyCount() - before} new key, zbarimg reads "${decoded}", exit ${exit}`)
  return ok
}

async function agents(agent: string, rounds: number) {
  const page = await owner()
  let passed = 0
  for (let round = 1; round <= rounds; round++) if (await attempt(agent, round, page)) passed++
  console.log(`${agent}: ${passed} of ${rounds} connected and made the QR, each with one approval and in under 60 s`)
  console.log(`transcripts, keys masked: ${evidence}`)
  assert.equal(passed, rounds)
}

async function checks() {
  const page = await owner()
  // 20 agents from 20 addresses, as Cloudflare would report them: one address starts 5 a minute.
  const pair = async (agent: string, index: number) => (await (await fetch(`${agentUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${index}` },
    body: JSON.stringify({ agent }),
  })).json()) as { pair_id: string, code: string }
  const waiting = await Promise.all(Array.from({ length: 20 }, (_, index) => pair(`waiting ${index}`, index)))
  const holds = waiting.map(({ pair_id: id }) => fetch(`${agentUrl}/pair/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pair_id: id }),
  }))
  await sleep(500)
  const times: number[] = []
  for (let request = 0; request < 200; request++) {
    const started = performance.now()
    await fetch(`${agentUrl}/health`)
    times.push(performance.now() - started)
  }
  times.sort((x, y) => x - y)
  const [p50, p99] = [Number(times[99]), Number(times[197])]
  console.log(`/health while 20 token requests wait, 200 requests: p50 ${p50.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms`)
  assert.ok(p99 <= 50, 'the limit is 50 ms')
  console.log('ok p99 is 50 ms or less')
  const statuses = (await Promise.all(holds)).map(({ status }) => status)
  assert.ok(statuses.every((status) => status === 202), statuses.join())
  console.log('ok the 20 held requests answered 202 pending after 25 s')

  const answers = []
  for (let attempt = 0; attempt < 6; attempt++) answers.push(await typeCode(page, 'WRON-GCOD'))
  assert.ok(answers.every((text) => text.startsWith('No agent is waiting')))
  const seventh = await typeCode(page, String(waiting[0]?.code))
  assert.match(seventh, /^Too many wrong codes\. Try again in \d+ s\.$/)
  console.log(`ok 6 wrong codes in the dashboard, then a right one: "${seventh}"`)
}

if (mode === 'checks') await checks()
else await agents(mode, Number(count))
await browser.close()
server.kill('SIGTERM')
await once(server, 'exit')
