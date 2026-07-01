import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { toHostSessionState, toPlayerSessionState } from '../domain/public.js'
import type { SessionService } from '../services/sessionService.js'
import type { TemplateService } from '../services/templateService.js'
import {
  answerSchema,
  createSessionSchema,
  createTemplateSchema,
  joinSessionSchema,
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
  notifySessionChange?: (code: string) => Promise<void> | void
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

      return reply.code(201).send({
        url: `${request.protocol}://${request.headers.host}/uploads/${fileName}`,
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

  app.get('/admin/sessions/:code', { preHandler: adminGuard }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const snapshot = await deps.sessionService.getSnapshotByCode(code)

    if (!snapshot) return reply.code(404).send({ error: 'Session not found' })

    return toHostSessionState(snapshot.template, snapshot.session)
  })

  app.post('/admin/sessions/:code/open-lobby', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.setStatus(code, 'lobby_open')
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/admin/sessions/:code/lock-lobby', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.setStatus(code, 'lobby_locked')
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

  app.post('/admin/sessions/:code/finish', { preHandler: adminGuard }, async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const snapshot = await deps.sessionService.setStatus(code, 'finished')
      await notify(code)

      return toHostSessionState(snapshot.template, snapshot.session)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/sessions/:code', async (request, reply) => {
    const { code } = request.params as { code: string }
    const snapshot = await deps.sessionService.getSnapshotByCode(code)

    if (!snapshot) return reply.code(404).send({ error: 'Session not found' })

    return toPlayerSessionState(snapshot.template, snapshot.session)
  })

  app.post('/sessions/:code/join', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const input = joinSessionSchema.parse(request.body)
      const { snapshot, player } = await deps.sessionService.joinSession(code, input.name)
      await notify(code)

      return reply.code(201).send({
        player,
        state: toPlayerSessionState(snapshot.template, snapshot.session),
      })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/sessions/:code/answer', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const input = answerSchema.parse(request.body)
      const { answer } = await deps.sessionService.submitAnswer(code, input.playerId, input.optionId)
      await notify(code)

      return reply.code(201).send({ answer })
    } catch (error) {
      return sendError(reply, error)
    }
  })
}
