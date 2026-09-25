import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const PLAYER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function createPlayerToken() {
  return randomBytes(32).toString('base64url')
}

export function isValidPlayerToken(token: unknown): token is string {
  return typeof token === 'string' && PLAYER_TOKEN_PATTERN.test(token)
}

export function hashPlayerToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function playerTokenMatches(token: string, expectedHash: string | null | undefined) {
  if (!isValidPlayerToken(token) || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return false

  const actual = Buffer.from(hashPlayerToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function playerTokenFingerprint(token: unknown) {
  if (typeof token !== 'string') return 'invalid'
  return hashPlayerToken(token).slice(0, 24)
}
