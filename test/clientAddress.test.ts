import assert from 'node:assert/strict'
import test from 'node:test'
import { getClientAddress } from '../src/security/clientAddress.js'

test('accepts the nearest forwarded address only from the local reverse proxy', () => {
  assert.equal(getClientAddress('198.51.100.4, 203.0.113.8', '127.0.0.1'), '203.0.113.8')
  assert.equal(getClientAddress('198.51.100.4', '::ffff:127.0.0.1'), '198.51.100.4')
})

test('ignores forged forwarding headers from direct clients', () => {
  assert.equal(getClientAddress('198.51.100.4', '203.0.113.8'), '203.0.113.8')
  assert.equal(getClientAddress(undefined, undefined), 'unknown')
})
