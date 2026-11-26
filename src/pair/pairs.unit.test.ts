// unit-test-reason: a pairing code expires after 10 real minutes, which a test would wait out.
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { Pairs } from './pairs.js'

function clock() {
  const time = { now: 1_000_000 }
  return { time, pairs: new Pairs(20, 10 * 60_000, () => time.now) }
}

test('pending, then approved by its code, then used', async () => {
  const { pairs } = clock()
  const started = pairs.start('Claude Code')
  assert.ok(started)
  assert.equal(await pairs.claim(started.id, 0), 'pending')
  assert.equal(pairs.approve(started.code.toLowerCase()), 'Claude Code')
  assert.deepEqual(await pairs.claim(started.id, 0), { agent: 'Claude Code' })
  assert.equal(await pairs.claim(started.id, 0), 'unknown')
})

test('a wrong code approves nothing', async () => {
  const { pairs } = clock()
  const started = pairs.start('agent')
  assert.ok(started)
  assert.equal(pairs.approve('AAAA-AAAA'), undefined)
  assert.equal(pairs.approve(''), undefined)
  assert.equal(await pairs.claim(started.id, 0), 'pending')
})

test('after 10 minutes the code and the pair_id expire, approved or not', async () => {
  const { time, pairs } = clock()
  const pending = pairs.start('late')
  const approved = pairs.start('slow claimer')
  assert.ok(pending && approved)
  pairs.approve(approved.code)
  time.now += 10 * 60_000
  assert.equal(pairs.approve(pending.code), undefined)
  assert.equal(await pairs.claim(pending.id, 0), 'unknown')
  assert.equal(await pairs.claim(approved.id, 0), 'unknown')
})

test('two claims waiting at once: one gets the agent, the other unknown', async () => {
  const { pairs } = clock()
  const started = pairs.start('twin')
  assert.ok(started)
  const claims = [pairs.claim(started.id, 5_000), pairs.claim(started.id, 5_000)]
  pairs.approve(started.code)
  assert.deepEqual(await Promise.all(claims), [{ agent: 'twin' }, 'unknown'])
})

test('expired pairs stop counting toward the 20 waiting', () => {
  const { time, pairs } = clock()
  for (let agent = 0; agent < 20; agent++) assert.ok(pairs.start(`agent ${agent}`))
  assert.equal(pairs.start('one more'), undefined)
  time.now += 10 * 60_000
  assert.ok(pairs.start('one more'))
})
