import type { GameTemplate, LiveSession } from '../domain/types.js'
import type { QuizRepository } from './quizRepository.js'

export class InMemoryQuizRepository implements QuizRepository {
  private templates = new Map<string, GameTemplate>()
  private sessions = new Map<string, LiveSession>()

  async listTemplates() {
    return Array.from(this.templates.values())
  }

  async getTemplate(id: string) {
    return this.templates.get(id) || null
  }

  async createTemplate(template: GameTemplate) {
    this.templates.set(template.id, template)

    return template
  }

  async updateTemplate(template: GameTemplate) {
    this.templates.set(template.id, template)

    return template
  }

  async deleteTemplate(id: string) {
    this.templates.delete(id)
  }

  async listSessions() {
    return Array.from(this.sessions.values())
  }

  async getSessionByCode(code: string) {
    const normalizedCode = code.trim().toUpperCase()

    return Array.from(this.sessions.values()).find((session) => session.code === normalizedCode) || null
  }

  async getSessionById(id: string) {
    return this.sessions.get(id) || null
  }

  async createSession(session: LiveSession) {
    this.sessions.set(session.id, session)

    return session
  }

  async updateSession(session: LiveSession) {
    this.sessions.set(session.id, session)

    return session
  }
}
