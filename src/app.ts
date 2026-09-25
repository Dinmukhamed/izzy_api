import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { join } from 'node:path'
import { registerRoutes } from './http/routes.js'
import { createRealtimeServer } from './realtime/socket.js'
import { SqliteQuizRepository } from './repositories/sqliteQuizRepository.js'
import { seedDemoTemplate } from './seed/devSeed.js'
import { SessionService } from './services/sessionService.js'
import { TemplateService } from './services/templateService.js'
import { RateLimiter } from './security/rateLimiter.js'

export type AppConfig = {
  adminToken: string
  corsOrigins: string[]
  dataDir?: string
  publicBaseUrl?: string
  logger?: boolean
}

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: config.logger ?? true,
    // Production traffic reaches the API through the local nginx instance.
    // Trust only that hop so clients cannot evade IP limits with a forged header.
    trustProxy: ['127.0.0.1', '::1'],
  })

  await app.register(cors, {
    origin: (origin, callback) => {
      const isConfiguredOrigin = !origin || config.corsOrigins.includes(origin)
      const isLocalDevelopmentOrigin = Boolean(
        origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      )

      callback(null, isConfiguredOrigin || isLocalDevelopmentOrigin)
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })

  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  })

  const dataDir = config.dataDir || join(process.cwd(), 'data')
  const repository = new SqliteQuizRepository(join(dataDir, 'izzy.sqlite'))
  const templateService = new TemplateService(repository)
  const sessionService = new SessionService(repository)
  const rateLimiter = new RateLimiter()
  const realtime = createRealtimeServer(app.server, {
    adminToken: config.adminToken,
    corsOrigins: config.corsOrigins,
    sessionService,
    rateLimiter,
  })
  app.addHook('preClose', async () => realtime.close())

  await registerRoutes(app, {
    adminToken: config.adminToken,
    templateService,
    sessionService,
    uploadDir: join(dataDir, 'uploads'),
    publicBaseUrl: config.publicBaseUrl,
    notifySessionChange: realtime.emitSessionState,
    rateLimiter,
  })

  const demoTemplate = await seedDemoTemplate(templateService)
  await sessionService.resetPlayerConnections()
  await realtime.resumeSessions()

  return {
    app,
    realtime,
    services: {
      templateService,
      sessionService,
    },
    demoTemplate,
  }
}
