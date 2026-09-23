import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GameTemplate, LiveSession } from '../domain/types.js'
import type { QuizRepository } from './quizRepository.js'

type DatabaseShape = {
  templates: GameTemplate[]
  sessions: LiveSession[]
}

const emptyDatabase = (): DatabaseShape => ({
  templates: [],
  sessions: [],
})

export class JsonQuizRepository implements QuizRepository {
  private database: DatabaseShape | null = null
  private writeQueue = Promise.resolve()

  constructor(private readonly databasePath: string) {}

  async listTemplates() {
    const database = await this.load()

    return database.templates
  }

  async getTemplate(id: string) {
    const database = await this.load()

    return database.templates.find((template) => template.id === id) || null
  }

  async createTemplate(template: GameTemplate) {
    const database = await this.load()
    database.templates.push(template)
    await this.persist()

    return template
  }

  async updateTemplate(template: GameTemplate) {
    const database = await this.load()
    const templateIndex = database.templates.findIndex((candidate) => candidate.id === template.id)

    if (templateIndex === -1) database.templates.push(template)
    else database.templates[templateIndex] = template

    await this.persist()

    return template
  }

  async deleteTemplate(id: string) {
    const database = await this.load()
    database.templates = database.templates.filter((template) => template.id !== id)
    await this.persist()
  }

  async listSessions() {
    const database = await this.load()

    return database.sessions
  }

  async getSessionByCode(code: string) {
    const database = await this.load()
    const normalizedCode = code.trim().toUpperCase()

    return database.sessions.find((session) => session.code === normalizedCode) || null
  }

  async getSessionById(id: string) {
    const database = await this.load()

    return database.sessions.find((session) => session.id === id) || null
  }

  async createSession(session: LiveSession) {
    const database = await this.load()
    database.sessions.push(session)
    await this.persist()

    return session
  }

  async updateSession(session: LiveSession) {
    const database = await this.load()
    const sessionIndex = database.sessions.findIndex((candidate) => candidate.id === session.id)

    if (sessionIndex === -1) database.sessions.push(session)
    else database.sessions[sessionIndex] = session

    await this.persist()

    return session
  }

  private async load() {
    if (this.database) return this.database

    try {
      const rawDatabase = await readFile(this.databasePath, 'utf8')
      this.database = JSON.parse(rawDatabase) as DatabaseShape
    } catch {
      this.database = emptyDatabase()
      await this.persist()
    }

    return this.database
  }

  private async persist() {
    if (!this.database) return

    const payload = JSON.stringify(this.database, null, 2)

    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.databasePath), { recursive: true })
      await writeFile(this.databasePath, payload)
    })

    await this.writeQueue
  }
}
