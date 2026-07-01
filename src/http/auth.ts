import type { FastifyReply, FastifyRequest } from 'fastify'

export function createAdminGuard(adminToken: string) {
  return async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
    const authorization = request.headers.authorization
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null

    if (!adminToken || token !== adminToken) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
  }
}
