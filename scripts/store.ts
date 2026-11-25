import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Key } from '../src/store/keys.js'
import type { Command } from '../src/store/main.js'

type Created = { key: Key, secret: string }

// The repository is on disk, while /tmp can be in memory and hide the cost of writing.
const data = join(import.meta.dirname, '../data')
mkdirSync(data, { recursive: true })
const root = mkdtempSync(join(data, 'live-'))
process.on('exit', () => rmSync(root, { recursive: true }))
const program = join(import.meta.dirname, '../dist/store.js')

function open(dir: string) {
  const child = spawn(process.execPath, [program, dir], { stdio: ['pipe', 'pipe', 'inherit'] })
  child.stdin.on('error', () => undefined)
  const reader = createInterface({ input: child.stdout })
  const lines = reader[Symbol.asyncIterator]()
  return {
    child,
    async ask<Result>(command: Command): Promise<Result> {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      const line = await lines.next()
      if (line.done) throw new Error('the program ended')
      const answer = JSON.parse(line.value) as { result: Result, error?: string }
      assert.equal(answer.error, undefined)
      return answer.result
    },
    async close() {
      child.stdin.end()
      await once(child, 'close')
    },
  }
}

async function secretsOnDisk() {
  const dir = join(root, 'secrets')
  const store = open(dir)
  const { key, secret } = await store.ask<Created>({ do: 'key.create', name: 'live' })
  await store.ask({ do: 'key.authenticate', secret })
  const grep = () => spawnSync('grep', ['-raF', secret.slice(3), dir]).status
  assert.equal(grep(), 1)
  const control = spawnSync('grep', ['-raF', key.id, dir]).status
  assert.equal(control, 0)
  const [listed] = await store.ask<Key[]>({ do: 'key.list' })
  assert.equal(key.lastUsedAt, null)
  assert.ok(listed?.lastUsedAt)
  await store.close()
  assert.equal(grep(), 1)
  console.log('ok grep -r finds the key id but never the key, and lastUsedAt changed')
}

async function killed() {
  const dir = join(root, 'killed')
  const confirmed: string[] = []
  const revoked: string[] = []
  for (let round = 0; round < 20; round++) {
    const store = open(dir)
    const before = confirmed.length
    const writing = (async () => {
      for (;;) {
        const { key, secret } = await store.ask<Created>({ do: 'key.create', name: 'x' })
        if (confirmed.length % 2 === 0) {
          confirmed.push(secret)
          continue
        }
        const spare = await store.ask<Created>({ do: 'key.create', name: 'x' })
        await store.ask({ do: 'key.revoke', id: spare.key.id })
        revoked.push(spare.secret)
        confirmed.push(secret)
        await store.ask({ do: 'file.save', name: 'x', mime: 'x', path: program })
        await store.ask({
          do: 'call.record',
          call: { at: '', keyId: key.id, tool: 'x', via: 'rest', ms: 1, error: null },
        })
      }
    })()
      .catch(() => undefined)
    while (confirmed.length === before) await sleep(5)
    await sleep(Math.random() * 100)
    store.child.kill('SIGKILL')
    await writing
    const database = new DatabaseSync(join(dir, 'toolshed.db'))
    const check = database.prepare('PRAGMA integrity_check')
      .get()
    assert.equal(check?.integrity_check, 'ok')
    database.close()
  }
  const store = open(dir)
  for (const secret of confirmed) assert.ok(await store.ask({ do: 'key.authenticate', secret }))
  for (const secret of revoked) {
    assert.equal(await store.ask({ do: 'key.authenticate', secret }), null)
  }
  await store.close()
  console.log(`ok 20 kill -9: integrity_check ok, ${confirmed.length} confirmed keys work, ${revoked.length} revoked keys do not`)
}

async function together() {
  for (let round = 0; round < 20; round++) {
    const stores = Array.from({ length: 6 }, () => open(join(root, `together-${round}`)))
    await Promise.all(stores.map((store) => store.ask({ do: 'key.create', name: 'x' })))
    await Promise.all(stores.map((store) => store.close()))
  }
  console.log('ok 20 times, 6 processes create the same database at once')
}

async function perf() {
  const dir = join(root, 'perf')
  const store = open(dir)
  const keys: Created[] = []
  for (let index = 0; index < 100; index++) {
    keys.push(await store.ask<Created>({ do: 'key.create', name: `key ${index}` }))
  }
  const database = new DatabaseSync(join(dir, 'toolshed.db'))
  database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
    INSERT INTO calls (at, key_id, tool, via, ms) SELECT 'x', '${keys[0]?.key.id}', 'qr.create', 'rest', i FROM n`)
  database.close()
  const times: number[] = []
  for (let round = 0; round < 50; round++) {
    for (const { secret } of keys) {
      const start = performance.now()
      assert.ok(await store.ask({ do: 'key.authenticate', secret }))
      times.push(performance.now() - start)
    }
  }
  await store.close()
  times.sort((a, b) => a - b)
  const at = (part: number) => (times[Math.floor(times.length * part)] ?? Infinity).toFixed(2)
  console.log(`authenticate with 100 keys and 100000 calls, ${times.length} times: median ${at(0.5)} ms, p99 ${at(0.99)} ms`)
  assert.ok(Number(at(0.99)) <= 5, 'the limit is 5 ms')
}

await secretsOnDisk()
await killed()
await together()
await perf()
