// unit-test-reason: the lockout ends after a real minute, which an integration test would wait out.
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { LoginLimiter } from './limiter.js'

test('five failures lock attempts until the oldest is a minute old', () => {
  let now = 1_000_000
  const limiter = new LoginLimiter(60_000, 5, () => now)
  for (let failure = 0; failure < 5; failure++) {
    assert.equal(limiter.wait(), 0)
    limiter.fail()
    now += 1_000
  }
  assert.equal(limiter.wait(), 55)
  now += 54_500
  assert.equal(limiter.wait(), 1)
  now += 500
  assert.equal(limiter.wait(), 0)
  limiter.fail()
  assert.equal(limiter.wait(), 1)
})
