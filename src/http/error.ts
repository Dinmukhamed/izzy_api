import type { FastifyReply } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../domain/errors.js'

export function sendError(reply: FastifyReply, error: unknown, statusCode = 400) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation failed', details: error.issues })
  }

  if (error instanceof AppError) {
    if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds))
    return reply.code(error.statusCode).send({ error: error.message })
  }

  if (error instanceof Error) {
    return reply.code(statusCode).send({ error: error.message })
  }

  return reply.code(statusCode).send({ error: 'Unexpected error' })
}
