import { RateLimitError } from '../domain/errors.js'

type RateLimitEntry = {
  count: number
  resetAt: number
}

export type RateLimitRule = {
  bucket: string
  key: string
  limit: number
  windowMs: number
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>()
  private operationsSinceCleanup = 0

  constructor(private readonly now: () => number = Date.now) {}

  consume(...rules: RateLimitRule[]) {
    const now = this.now()
    const prepared = rules.map((rule) => {
      const storageKey = `${rule.bucket}:${rule.key}`
      const current = this.entries.get(storageKey)
      const entry = !current || current.resetAt <= now
        ? { count: 0, resetAt: now + rule.windowMs }
        : current

      if (entry.count >= rule.limit) {
        throw new RateLimitError(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)))
      }

      return { storageKey, entry }
    })

    for (const { storageKey, entry } of prepared) {
      entry.count += 1
      this.entries.set(storageKey, entry)
    }

    this.operationsSinceCleanup += 1
    if (this.operationsSinceCleanup >= 500) this.cleanup(now)
  }

  private cleanup(now: number) {
    this.operationsSinceCleanup = 0
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key)
    }
  }
}
