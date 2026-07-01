import type { FastifyReply } from 'fastify'
import { ZodError } from 'zod'

export function sendError(reply: FastifyReply, error: unknown, statusCode = 400) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation failed', details: error.issues })
  }

  if (error instanceof Error) {
    return reply.code(statusCode).send({ error: error.message })
  }

  return reply.code(statusCode).send({ error: 'Unexpected error' })
}
