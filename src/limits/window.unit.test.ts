// unit-test-reason: a window ends after a real minute, which an integration test would wait out.
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { SlidingWindow } from './window.js'

test('five failures lock attempts until the oldest is a minute old', () => {
  let now = 1_000_000
  const limiter = new SlidingWindow(60_000, 5, () => now)
  for (let failure = 0; failure < 5; failure++) {
    assert.equal(limiter.wait(), 0)
    limiter.add()
    now += 1_000
  }
  assert.equal(limiter.wait(), 55)
  now += 54_500
  assert.equal(limiter.wait(), 1)
  now += 500
  assert.equal(limiter.wait(), 0)
  limiter.add()
  assert.equal(limiter.wait(), 1)
})

test('the 61st call of a key in a minute waits, and another key does not', () => {
  let now = 1_000_000
  const calls = new SlidingWindow(60_000, 60, () => now)
  for (let call = 0; call < 60; call++) {
    assert.equal(calls.take('key_a'), 0)
    now += 500
  }
  assert.equal(calls.take('key_a'), 30)
  assert.equal(calls.take('key_a'), 30, 'a refused call is not counted')
  assert.equal(calls.take('key_b'), 0)
  now += 30_000
  assert.equal(calls.take('key_a'), 0)
})

test('names with no event in the last minute are forgotten', () => {
  let now = 1_000_000
  const events = new Map<string, number[]>()
  const pairs = new SlidingWindow(60_000, 5, () => now, events)
  for (let ip = 0; ip < 1000; ip++) pairs.take(`203.0.113.${ip}`)
  now += 30_000
  pairs.take('198.51.100.1')
  assert.equal(events.size, 1001)
  now += 30_001
  pairs.take('198.51.100.2')
  assert.deepEqual([...events.keys()], ['198.51.100.1', '198.51.100.2'])
  pairs.take('198.51.100.1')
  assert.deepEqual([...events.keys()], ['198.51.100.2', '198.51.100.1'], 'a name moves to the back')
})
