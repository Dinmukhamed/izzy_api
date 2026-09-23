import { existsSync, readFileSync } from 'node:fs'
import { buildApp } from './app.js'

loadLocalEnv()

const port = Number(process.env.PORT || 4010)
const host = process.env.HOST || '127.0.0.1'
const adminToken = process.env.ADMIN_TOKEN || 'dev-admin-token'
const dataDir = process.env.DATA_DIR || 'data'
const publicBaseUrl = process.env.PUBLIC_BASE_URL
const corsOrigins = (process.env.CORS_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const { app, demoTemplate } = await buildApp({
  adminToken,
  corsOrigins,
  dataDir,
  publicBaseUrl,
})

try {
  await app.listen({ port, host })
  app.log.info({ templateId: demoTemplate.id }, 'Izzy API is ready')
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

function loadLocalEnv() {
  if (!existsSync('.env')) return

  const lines = readFileSync('.env', 'utf8').split('\n')

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith('#')) continue

    const separatorIndex = trimmedLine.indexOf('=')
    if (separatorIndex === -1) continue

    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1).trim()

    if (!process.env[key]) process.env[key] = value
  }
}
