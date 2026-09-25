import assert from 'node:assert/strict'
import test from 'node:test'
import { RateLimitError } from '../src/domain/errors.js'
import { RateLimiter } from '../src/security/rateLimiter.js'

test('rate limiter blocks excess attempts and resets after its window', () => {
  let now = 1_000
  const limiter = new RateLimiter(() => now)
  const rule = { bucket: 'answer', key: 'player', limit: 2, windowMs: 5_000 }

  limiter.consume(rule)
  limiter.consume(rule)
  assert.throws(() => limiter.consume(rule), (error) => {
    assert.ok(error instanceof RateLimitError)
    assert.equal(error.statusCode, 429)
    assert.equal(error.retryAfterSeconds, 5)
    return true
  })

  now += 5_000
  assert.doesNotThrow(() => limiter.consume(rule))
})

test('rate limiter does not partially consume a group when one rule is blocked', () => {
  const limiter = new RateLimiter(() => 1_000)
  const available = { bucket: 'ip', key: 'shared', limit: 2, windowMs: 60_000 }
  const blocked = { bucket: 'token', key: 'player', limit: 1, windowMs: 60_000 }

  limiter.consume(blocked)
  assert.throws(() => limiter.consume(available, blocked), RateLimitError)
  assert.doesNotThrow(() => limiter.consume(available))
  assert.doesNotThrow(() => limiter.consume(available))
})
