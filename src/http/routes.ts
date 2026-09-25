import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { toHostSessionState, toPlayerSessionState, toPublicPlayer } from '../domain/public.js'
import { PlayerAuthenticationError } from '../domain/errors.js'
import type { RateLimiter } from '../security/rateLimiter.js'
import { playerTokenFingerprint } from '../security/playerToken.js'
import type { SessionService } from '../services/sessionService.js'
import type { TemplateService } from '../services/templateService.js'
import {
  answerSchema,
  createSessionSchema,
  createTemplateSchema,
  joinSessionSchema,
  playerTokenSchema,
  updateTemplateSchema,
  updateTemplateStatusSchema,
} from '../validation/schemas.js'
import { createAdminGuard } from './auth.js'
import { sendError } from './error.js'

type RouteDeps = {
  adminToken: string
  templateService: TemplateService
  sessionService: SessionService
  uploadDir: string
  publicBaseUrl?: string
  notifySessionChange?: (code: string) => Promise<void> | void
  rateLimiter: RateLimiter
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const adminGuard = createAdminGuard(deps.adminToken)
  const notify = async (code: string) => deps.notifySessionChange?.(code)

  app.get('/health', async () => ({
    ok: true,
    service: 'izzy_api',
  }))

  app.get('/admin/templates', { preHandler: adminGuard }, async () => deps.templateService.listTemplates())

  app.post('/admin/templates', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const input = createTemplateSchema.parse(request.body)
      const template = await deps.templateService.createTemplate(input)

      return reply.code(201).send(template)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/admin/templates/:id', { preHandler: adminGuard }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const template = await deps.templateService.getTemplate(id)

    if (!template) return reply.code(404).send({ error: 'Template not found' })

    return template
  })

  app.put('/admin/templates/:id', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const input = updateTemplateSchema.parse(request.body)
      const template = await deps.templateService.updateTemplate(id, input)

      return template
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.patch('/admin/templates/:id/status', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const input = updateTemplateStatusSchema.parse(request.body)
      const template = await deps.templateService.updateTemplateStatus(id, input.status)

      return template
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/admin/templates/:id', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await deps.templateService.deleteTemplate(id)

      return reply.code(204).send()
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/uploads', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const file = await request.file()
      if (!file) return reply.code(400).send({ error: 'File is required' })

      const fileExtension = extname(file.filename)
      const safeBaseName = basename(file.filename, fileExtension)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'media'
      const fileName = `${Date.now()}-${safeBaseName}${fileExtension}`
      const fileBuffer = await file.toBuffer()

      await mkdir(deps.uploadDir, { recursive: true })
      await writeFile(join(deps.uploadDir, fileName), fileBuffer)
      const publicBaseUrl = deps.publicBaseUrl || `${request.protocol}://${request.headers.host}`

      return reply.code(201).send({
        url: `${publicBaseUrl.replace(/\/$/, '')}/uploads/${fileName}`,
        filename: file.filename,
        mimetype: file.mimetype,
        size: fileBuffer.length,
      })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/uploads/:fileName', async (request, reply) => {
    const { fileName } = request.params as { fileName: string }
    const safeFileName = basename(fileName)
    if (!safeFileName) return reply.code(404).send({ error: 'File not found' })

    const filePath = join(deps.uploadDir, safeFileName)

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) return reply.code(404).send({ error: 'File not found' })

      return reply.send(createReadStream(filePath))
    } catch {
      return reply.code(404).send({ error: 'File not found' })
    }
  })

  app.post('/admin/sessions', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const input = createSessionSchema.parse(request.body)
      const session = await deps.sessionService.createSession(input.templateId)

      return reply.code(201).send(session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/admin/sessions', { preHandler: adminGuard }, async () =>
    deps.sessionService.listSessionSummaries()
  )

  app.get('/admin/sessions/:code', { preHandler: adminGuard }, async (request, reply) => {
    const { code } = request.params as { code: string }
    try {
      const { snapshot, changed } = await deps.sessionService.advanceTimedPhases(code)
      if (changed) await notify(code)
      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error, 404)
    }
  })

  app.post('/admin/sessions/:code/open-lobby', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.setLobbyStatus(code, 'lobby_open')
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/lock-lobby', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.setLobbyStatus(code, 'lobby_locked')
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/start', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.startSession(code)
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/next-question', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.openNextQuestion(code)
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/close-question', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.closeQuestion(code)
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/show-answer', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.showAnswer(code)
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/skip-phase', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.skipPhase(code)
      await notify(code)
      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/pause', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.pauseSession(code)
      await notify(code)
      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/resume', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.resumeSession(code)
      await notify(code)
      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/finish', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.finishSession(code)
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/players/:playerId/revoke', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code, playerId } = request.params as { code: string; playerId: string }
      const snapshot = await deps.sessionService.revokePlayerAccess(code, playerId)
      await notify(code)
      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/sessions/:code', async (request, reply) => {
    const { code } = request.params as { code: string }
    try {
      const { snapshot, changed } = await deps.sessionService.advanceTimedPhases(code)
      if (changed) await notify(code)
      return toPlayerSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error, 404)
    }
  })

  app.post('/sessions/:code/join', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const normalizedCode = code.trim().toUpperCase()
      deps.rateLimiter.consume(
        { bucket: 'join-ip-code', key: `${request.ip}:${normalizedCode}`, limit: 75, windowMs: 5 * 60_000 },
        { bucket: 'join-ip-global', key: request.ip, limit: 200, windowMs: 5 * 60_000 },
        { bucket: 'join-code', key: normalizedCode, limit: 100, windowMs: 5 * 60_000 }
      )
      const input = joinSessionSchema.parse(request.body)
      const { snapshot, player, playerToken } = await deps.sessionService.joinSession(code, input.name)
      await notify(code)

      return reply.code(201).send({
        player: toPublicPlayer(player),
        playerToken,
        state: toPlayerSessionState(snapshot.template, snapshot.session),
      })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/sessions/:code/player', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const normalizedCode = code.trim().toUpperCase()
      deps.rateLimiter.consume({ bucket: 'state-ip-code', key: `${request.ip}:${normalizedCode}`, limit: 600, windowMs: 60_000 })
      const playerToken = getPlayerToken(request.headers.authorization)
      deps.rateLimiter.consume({ bucket: 'state-token', key: playerTokenFingerprint(playerToken), limit: 60, windowMs: 60_000 })
      const { snapshot, player, changed } = await deps.sessionService.getAuthenticatedPlayerSession(code, playerToken)
      if (changed) await notify(code)
      return {
        player: toPublicPlayer(player),
        state: toPlayerSessionState(snapshot.template, snapshot.session),
      }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/sessions/:code/answer', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const normalizedCode = code.trim().toUpperCase()
      deps.rateLimiter.consume({ bucket: 'answer-ip-code', key: `${request.ip}:${normalizedCode}`, limit: 400, windowMs: 60_000 })
      const input = answerSchema.parse(request.body)
      const playerToken = getPlayerToken(request.headers.authorization)
      deps.rateLimiter.consume({ bucket: 'answer-token', key: playerTokenFingerprint(playerToken), limit: 30, windowMs: 60_000 })
      const { answer, duplicate } = await deps.sessionService.submitAnswer(
        code,
        playerToken,
        input.optionId,
        input.requestId
      )
      if (!duplicate) await notify(code)

      return reply.code(duplicate ? 200 : 201).send({ answer, duplicate })
    } catch (error) {
      return sendError(reply, error)
    }
  })
}

function getPlayerToken(authorization: string | undefined) {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  const parsed = playerTokenSchema.safeParse(token)
  if (!parsed.success) throw new PlayerAuthenticationError()
  return parsed.data
}
