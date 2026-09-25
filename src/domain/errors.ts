export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class PlayerAuthenticationError extends AppError {
  constructor() {
    super('Player session is invalid', 401)
    this.name = 'PlayerAuthenticationError'
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(`Too many attempts. Try again in ${retryAfterSeconds} seconds`, 429, retryAfterSeconds)
    this.name = 'RateLimitError'
  }
}
