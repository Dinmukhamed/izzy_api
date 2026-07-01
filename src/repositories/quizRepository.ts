import type { GameTemplate, LiveSession } from '../domain/types.js'

export type QuizRepository = {
  listTemplates(): Promise<GameTemplate[]>
  getTemplate(id: string): Promise<GameTemplate | null>
  createTemplate(template: GameTemplate): Promise<GameTemplate>
  updateTemplate(template: GameTemplate): Promise<GameTemplate>

  listSessions(): Promise<LiveSession[]>
  getSessionByCode(code: string): Promise<LiveSession | null>
  getSessionById(id: string): Promise<LiveSession | null>
  createSession(session: LiveSession): Promise<LiveSession>
  updateSession(session: LiveSession): Promise<LiveSession>
}
