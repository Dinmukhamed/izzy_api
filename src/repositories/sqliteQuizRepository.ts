import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GameTemplate, LiveSession } from '../domain/types.js'
import type { QuizRepository } from './quizRepository.js'

type TemplateRow = {
  id: string
  title: string
  status: GameTemplate['status']
  payload: string
  created_at: string
  updated_at: string
}

type SessionRow = {
  id: string
  code: string
  template_id: string
  status: LiveSession['status']
  payload: string
  created_at: string
  updated_at: string
}

export class SqliteQuizRepository implements QuizRepository {
  private readonly database: Database.Database

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.migrate()
  }

  async listTemplates() {
    const rows = this.database
      .prepare('SELECT payload FROM templates ORDER BY updated_at DESC')
      .all() as Array<{ payload: string }>

    return rows.map((row) => JSON.parse(row.payload) as GameTemplate)
  }

  async getTemplate(id: string) {
    const row = this.database.prepare('SELECT payload FROM templates WHERE id = ?').get(id) as
      | { payload: string }
      | undefined

    return row ? (JSON.parse(row.payload) as GameTemplate) : null
  }

  async createTemplate(template: GameTemplate) {
    this.upsertTemplate(template)

    return template
  }

  async updateTemplate(template: GameTemplate) {
    this.upsertTemplate(template)

    return template
  }

  async deleteTemplate(id: string) {
    this.database.prepare('DELETE FROM templates WHERE id = ?').run(id)
  }

  async listSessions() {
    const rows = this.database
      .prepare('SELECT payload FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{ payload: string }>

    return rows.map((row) => JSON.parse(row.payload) as LiveSession)
  }

  async getSessionByCode(code: string) {
    const normalizedCode = code.trim().toUpperCase()
    const row = this.database.prepare('SELECT payload FROM sessions WHERE code = ?').get(normalizedCode) as
      | { payload: string }
      | undefined

    return row ? (JSON.parse(row.payload) as LiveSession) : null
  }

  async getSessionById(id: string) {
    const row = this.database.prepare('SELECT payload FROM sessions WHERE id = ?').get(id) as
      | { payload: string }
      | undefined

    return row ? (JSON.parse(row.payload) as LiveSession) : null
  }

  async createSession(session: LiveSession) {
    this.upsertSession(session)

    return session
  }

  async updateSession(session: LiveSession) {
    this.upsertSession(session)

    return session
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
      CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    `)
  }

  private upsertTemplate(template: GameTemplate) {
    const row: TemplateRow = {
      id: template.id,
      title: template.title,
      status: template.status,
      payload: JSON.stringify(template),
      created_at: template.createdAt,
      updated_at: template.updatedAt,
    }

    this.database
      .prepare(
        `
          INSERT INTO templates (id, title, status, payload, created_at, updated_at)
          VALUES (@id, @title, @status, @payload, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `
      )
      .run(row)
  }

  private upsertSession(session: LiveSession) {
    const row: SessionRow = {
      id: session.id,
      code: session.code,
      template_id: session.templateId,
      status: session.status,
      payload: JSON.stringify(session),
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }

    this.database
      .prepare(
        `
          INSERT INTO sessions (id, code, template_id, status, payload, created_at, updated_at)
          VALUES (@id, @code, @template_id, @status, @payload, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            code = excluded.code,
            template_id = excluded.template_id,
            status = excluded.status,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `
      )
      .run(row)
  }
}
