import { getCurrentQuestion } from '../domain/public.js'
import { calculateAnswerScore } from '../domain/scoring.js'
import type { LiveSession, Player, PlayerAnswer, SessionSnapshot, SessionStatus } from '../domain/types.js'
import type { QuizRepository } from '../repositories/quizRepository.js'
import { createGameCode, createId } from '../utils/id.js'

export class SessionService {
  constructor(private readonly repository: QuizRepository) {}

  async createSession(templateId: string) {
    const template = await this.repository.getTemplate(templateId)
    if (!template) throw new Error('Template not found')
    if (template.status !== 'active') throw new Error('Template is not active')

    const now = new Date().toISOString()
    const session: LiveSession = {
      id: createId(),
      code: await this.createUniqueCode(),
      templateId,
      status: 'lobby_open',
      players: [],
      answers: [],
      currentQuestionIndex: null,
      questionStartedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    return this.repository.createSession(session)
  }

  async getSnapshotByCode(code: string): Promise<SessionSnapshot | null> {
    const session = await this.repository.getSessionByCode(code)
    if (!session) return null

    const template = await this.repository.getTemplate(session.templateId)
    if (!template) return null

    return { session, template }
  }

  async joinSession(code: string, name: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session } = snapshot

    if (session.status !== 'lobby_open') {
      throw new Error('Lobby is not open')
    }

    const normalizedName = name.trim()
    const nameExists = session.players.some(
      (player) => player.name.toLowerCase() === normalizedName.toLowerCase()
    )

    if (nameExists) throw new Error('Player name already exists')

    const player: Player = {
      id: createId(),
      name: normalizedName,
      score: 0,
      joinedAt: new Date().toISOString(),
      connected: true,
    }

    session.players.push(player)
    await this.touch(session)

    return { snapshot, player }
  }

  async setPlayerConnection(code: string, playerId: string, connected: boolean) {
    const snapshot = await this.requireSnapshot(code)
    const player = snapshot.session.players.find((candidate) => candidate.id === playerId)
    if (!player) return snapshot

    player.connected = connected
    await this.touch(snapshot.session)

    return snapshot
  }

  async setStatus(code: string, status: Extract<SessionStatus, 'lobby_open' | 'lobby_locked' | 'finished'>) {
    const snapshot = await this.requireSnapshot(code)
    snapshot.session.status = status

    if (status === 'finished') {
      snapshot.session.questionStartedAt = null
    }

    await this.touch(snapshot.session)

    return snapshot
  }

  async startSession(code: string) {
    const snapshot = await this.requireSnapshot(code)

    if (snapshot.session.players.length === 0) throw new Error('Cannot start without players')
    if (!snapshot.template.questions[0]) throw new Error('Template has no questions')

    snapshot.session.status = 'question_open'
    snapshot.session.currentQuestionIndex = 0
    snapshot.session.questionStartedAt = new Date().toISOString()
    await this.touch(snapshot.session)

    return snapshot
  }

  async openNextQuestion(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session, template } = snapshot
    const nextIndex = session.currentQuestionIndex === null ? 0 : session.currentQuestionIndex + 1

    if (!template.questions[nextIndex]) throw new Error('No more questions')

    session.currentQuestionIndex = nextIndex
    session.questionStartedAt = new Date().toISOString()
    session.status = 'question_open'
    await this.touch(session)

    return snapshot
  }

  async closeQuestion(code: string) {
    const snapshot = await this.requireSnapshot(code)
    snapshot.session.status = 'question_closed'
    await this.touch(snapshot.session)

    return snapshot
  }

  async showAnswer(code: string) {
    const snapshot = await this.requireSnapshot(code)
    snapshot.session.status = 'show_answer'
    await this.touch(snapshot.session)

    return snapshot
  }

  async showAnswerIfCurrentQuestion(code: string, questionId: string) {
    const snapshot = await this.requireSnapshot(code)
    const currentQuestion = getCurrentQuestion(snapshot.template, snapshot.session)

    if (snapshot.session.status !== 'question_open' || currentQuestion?.id !== questionId) {
      return snapshot
    }

    snapshot.session.status = 'show_answer'
    await this.touch(snapshot.session)

    return snapshot
  }

  async submitAnswer(code: string, playerId: string, optionId: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session, template } = snapshot

    if (session.status !== 'question_open') throw new Error('Question is not open')
    if (!session.questionStartedAt) throw new Error('Question has not started')

    const player = session.players.find((candidate) => candidate.id === playerId)
    if (!player) throw new Error('Player not found')

    const question = getCurrentQuestion(template, session)
    if (!question) throw new Error('Question not found')

    const alreadyAnswered = session.answers.some(
      (answer) => answer.playerId === playerId && answer.questionId === question.id
    )
    if (alreadyAnswered) throw new Error('Player already answered')

    const answeredAtMs = Date.now()
    const elapsedMs = answeredAtMs - new Date(session.questionStartedAt).getTime()
    const isCorrect = optionId === question.correctOptionId
    const score = calculateAnswerScore({
      isCorrect,
      elapsedMs,
      durationMs: question.durationMs,
      maxPoints: question.points,
    })

    const answer: PlayerAnswer = {
      id: createId(),
      playerId,
      questionId: question.id,
      optionId,
      isCorrect,
      score,
      elapsedMs,
      answeredAt: new Date(answeredAtMs).toISOString(),
    }

    player.score += score
    session.answers.push(answer)
    await this.touch(session)

    return { snapshot, answer }
  }

  private async createUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = createGameCode()
      const existingSession = await this.repository.getSessionByCode(code)
      if (!existingSession) return code
    }

    throw new Error('Could not create unique game code')
  }

  private async requireSnapshot(code: string) {
    const snapshot = await this.getSnapshotByCode(code)
    if (!snapshot) throw new Error('Session not found')

    return snapshot
  }

  private async touch(session: LiveSession) {
    session.updatedAt = new Date().toISOString()

    return this.repository.updateSession(session)
  }
}
