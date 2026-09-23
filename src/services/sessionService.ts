import {
  LIVE_ANSWER_REVEAL_DURATION_MS,
  LIVE_COUNTDOWN_DURATION_MS,
  LIVE_LEADERBOARD_DURATION_MS,
  LIVE_QUESTION_DURATION_MS,
} from '../domain/constants.js'
import { getCurrentQuestion } from '../domain/public.js'
import { calculateAnswerScore } from '../domain/scoring.js'
import type {
  LiveSession,
  Player,
  PlayerAnswer,
  SessionSnapshot,
  SessionStatus,
  TimedSessionStatus,
} from '../domain/types.js'
import type { QuizRepository } from '../repositories/quizRepository.js'
import { createGameCode, createId } from '../utils/id.js'

const TIMED_STATUSES: TimedSessionStatus[] = ['countdown', 'question_open', 'show_answer', 'leaderboard']

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
      templateSnapshot: cloneTemplate(template),
      status: 'lobby_open',
      players: [],
      answers: [],
      currentQuestionIndex: null,
      questionStartedAt: null,
      phaseEndsAt: null,
      pausedPhase: null,
      pausedRemainingMs: null,
      questionPlayerIds: [],
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
    }

    return this.repository.createSession(session)
  }

  async listSessions() {
    return this.repository.listSessions()
  }

  async resetPlayerConnections() {
    const sessions = await this.repository.listSessions()

    for (const session of sessions) {
      if (!session.players.some((player) => player.connected)) continue
      session.players.forEach((player) => { player.connected = false })
      await this.touch(session)
    }
  }

  async listSessionSummaries() {
    const sessions = await this.repository.listSessions()
    const summaries = await Promise.all(
      sessions.map(async (session) => {
        const template = session.templateSnapshot || (await this.repository.getTemplate(session.templateId))

        return {
          id: session.id,
          code: session.code,
          templateId: session.templateId,
          templateTitle: template?.title || 'Deleted template',
          status: session.status,
          playerCount: session.players.length,
          connectedPlayerCount: session.players.filter((player) => player.connected).length,
          currentQuestionIndex: session.currentQuestionIndex,
          questionCount: template?.questions.length || 0,
          phaseEndsAt: session.phaseEndsAt || null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }
      })
    )

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getSnapshotByCode(code: string): Promise<SessionSnapshot | null> {
    const session = await this.repository.getSessionByCode(code)
    if (!session) return null

    let template = session.templateSnapshot

    if (!template) {
      const sourceTemplate = await this.repository.getTemplate(session.templateId)
      if (!sourceTemplate) return null

      template = cloneTemplate(sourceTemplate)
      session.templateSnapshot = template
      await this.touch(session)
    }

    return { session, template }
  }

  async joinSession(code: string, name: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session } = snapshot

    if (session.status !== 'lobby_open') throw new Error('Lobby is not open')

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
    if (!player || player.connected === connected) return snapshot

    player.connected = connected
    await this.touch(snapshot.session)
    return snapshot
  }

  async setLobbyStatus(code: string, status: 'lobby_open' | 'lobby_locked') {
    const snapshot = await this.requireSnapshot(code)
    if (!['lobby_open', 'lobby_locked'].includes(snapshot.session.status)) {
      throw new Error('Lobby can only be changed before the game starts')
    }

    snapshot.session.status = status
    await this.touch(snapshot.session)
    return snapshot
  }

  async setStatus(code: string, status: Extract<SessionStatus, 'lobby_open' | 'lobby_locked' | 'finished'>) {
    if (status === 'finished') return this.finishSession(code)
    return this.setLobbyStatus(code, status)
  }

  async startSession(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session, template } = snapshot

    if (!['lobby_open', 'lobby_locked'].includes(session.status)) throw new Error('Game has already started')
    if (session.players.length === 0) throw new Error('Cannot start without players')
    if (!template.questions[0]) throw new Error('Template has no questions')

    session.currentQuestionIndex = 0
    this.enterCountdown(session, Date.now())
    await this.touch(session)
    return snapshot
  }

  async openNextQuestion(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session, template } = snapshot

    if (!['show_answer', 'leaderboard', 'question_closed'].includes(session.status)) {
      throw new Error('The next question is not available in the current phase')
    }

    const nextIndex = session.currentQuestionIndex === null ? 0 : session.currentQuestionIndex + 1
    if (!template.questions[nextIndex]) return this.finishSession(code)

    session.currentQuestionIndex = nextIndex
    this.enterCountdown(session, Date.now())
    await this.touch(session)
    return snapshot
  }

  async closeQuestion(code: string) {
    return this.showAnswer(code)
  }

  async showAnswer(code: string) {
    const snapshot = await this.requireSnapshot(code)
    if (!['question_open', 'question_closed'].includes(snapshot.session.status)) {
      throw new Error('There is no open question to reveal')
    }

    this.enterAnswerReveal(snapshot.session, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async showAnswerIfCurrentQuestion(code: string, questionId: string) {
    const snapshot = await this.requireSnapshot(code)
    const currentQuestion = getCurrentQuestion(snapshot.template, snapshot.session)

    if (snapshot.session.status !== 'question_open' || currentQuestion?.id !== questionId) return snapshot

    this.enterAnswerReveal(snapshot.session, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async showAnswerIfEveryoneAnswered(code: string, questionId: string) {
    const snapshot = await this.requireSnapshot(code)
    const currentQuestion = getCurrentQuestion(snapshot.template, snapshot.session)
    if (snapshot.session.status !== 'question_open' || currentQuestion?.id !== questionId) return snapshot

    const participantIds = snapshot.session.questionPlayerIds?.length
      ? snapshot.session.questionPlayerIds
      : snapshot.session.players.map((player) => player.id)
    const answeredPlayerIds = new Set(
      snapshot.session.answers
        .filter((answer) => answer.questionId === questionId)
        .map((answer) => answer.playerId)
    )

    if (participantIds.length > 0 && participantIds.every((playerId) => answeredPlayerIds.has(playerId))) {
      this.enterAnswerReveal(snapshot.session, Date.now())
      await this.touch(snapshot.session)
    }

    return snapshot
  }

  async pauseSession(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session } = snapshot
    if (!isTimedStatus(session.status)) throw new Error('The game cannot be paused in the current phase')

    session.pausedPhase = session.status
    session.pausedRemainingMs = Math.max(0, dateMs(session.phaseEndsAt) - Date.now())
    session.status = 'paused'
    session.phaseEndsAt = null
    await this.touch(session)
    return snapshot
  }

  async resumeSession(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session } = snapshot
    if (session.status !== 'paused' || !session.pausedPhase) throw new Error('The game is not paused')

    session.status = session.pausedPhase
    session.phaseEndsAt = new Date(Date.now() + Math.max(250, session.pausedRemainingMs || 0)).toISOString()
    session.pausedPhase = null
    session.pausedRemainingMs = null
    await this.touch(session)
    return snapshot
  }

  async skipPhase(code: string) {
    const snapshot = await this.requireSnapshot(code)
    if (!isTimedStatus(snapshot.session.status)) throw new Error('There is no timed phase to skip')

    this.advanceOnePhase(snapshot, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async finishSession(code: string) {
    const snapshot = await this.requireSnapshot(code)
    snapshot.session.status = 'finished'
    snapshot.session.phaseEndsAt = null
    snapshot.session.pausedPhase = null
    snapshot.session.pausedRemainingMs = null
    await this.touch(snapshot.session)
    return snapshot
  }

  async advanceTimedPhases(code: string) {
    const snapshot = await this.requireSnapshot(code)
    const { session } = snapshot
    let changed = this.ensureTimedDeadline(session)
    let safety = 0

    while (isTimedStatus(session.status) && dateMs(session.phaseEndsAt) <= Date.now() && safety < 100) {
      const transitionAt = dateMs(session.phaseEndsAt) || Date.now()
      this.advanceOnePhase(snapshot, transitionAt)
      changed = true
      safety += 1
    }

    if (changed) await this.touch(session)
    return { snapshot, changed }
  }

  async submitAnswer(code: string, playerId: string, optionId: string) {
    const { snapshot } = await this.advanceTimedPhases(code)
    const { session, template } = snapshot

    if (session.status !== 'question_open') throw new Error('Question is not open')
    if (!session.phaseEndsAt || dateMs(session.phaseEndsAt) <= Date.now()) throw new Error('Time is up')

    const player = session.players.find((candidate) => candidate.id === playerId)
    if (!player) throw new Error('Player not found')

    const question = getCurrentQuestion(template, session)
    if (!question) throw new Error('Question not found')
    if (!question.options.some((option) => option.id === optionId)) throw new Error('Answer option not found')

    const alreadyAnswered = session.answers.some(
      (answer) => answer.playerId === playerId && answer.questionId === question.id
    )
    if (alreadyAnswered) throw new Error('Player already answered')

    const answeredAtMs = Date.now()
    const remainingMs = Math.max(0, dateMs(session.phaseEndsAt) - answeredAtMs)
    const elapsedMs = Math.max(0, LIVE_QUESTION_DURATION_MS - remainingMs)
    const isCorrect = optionId === question.correctOptionId
    const score = calculateAnswerScore({
      isCorrect,
      elapsedMs,
      durationMs: LIVE_QUESTION_DURATION_MS,
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

  private advanceOnePhase(snapshot: SessionSnapshot, transitionAt: number) {
    const { session, template } = snapshot

    if (session.status === 'countdown') {
      this.enterQuestion(session, transitionAt)
      return
    }

    if (session.status === 'question_open') {
      this.enterAnswerReveal(session, transitionAt)
      return
    }

    if (session.status === 'show_answer') {
      session.status = 'leaderboard'
      session.phaseEndsAt = new Date(transitionAt + LIVE_LEADERBOARD_DURATION_MS).toISOString()
      return
    }

    if (session.status === 'leaderboard') {
      const nextIndex = (session.currentQuestionIndex ?? -1) + 1
      if (!template.questions[nextIndex]) {
        session.status = 'finished'
        session.phaseEndsAt = null
        return
      }

      session.currentQuestionIndex = nextIndex
      this.enterCountdown(session, transitionAt)
    }
  }

  private enterCountdown(session: LiveSession, startedAt: number) {
    session.status = 'countdown'
    session.questionStartedAt = null
    session.questionPlayerIds = []
    session.phaseEndsAt = new Date(startedAt + LIVE_COUNTDOWN_DURATION_MS).toISOString()
    session.pausedPhase = null
    session.pausedRemainingMs = null
  }

  private enterQuestion(session: LiveSession, startedAt: number) {
    session.status = 'question_open'
    session.questionStartedAt = new Date(startedAt).toISOString()
    session.phaseEndsAt = new Date(startedAt + LIVE_QUESTION_DURATION_MS).toISOString()
    session.questionPlayerIds = session.players.map((player) => player.id)
  }

  private enterAnswerReveal(session: LiveSession, startedAt: number) {
    session.status = 'show_answer'
    session.phaseEndsAt = new Date(startedAt + LIVE_ANSWER_REVEAL_DURATION_MS).toISOString()
  }

  private ensureTimedDeadline(session: LiveSession) {
    if (!isTimedStatus(session.status) || session.phaseEndsAt) return false

    const duration = durationForStatus(session.status)
    session.phaseEndsAt = new Date(Date.now() + duration).toISOString()
    if (session.status === 'question_open' && !session.questionStartedAt) {
      session.questionStartedAt = new Date().toISOString()
    }
    return true
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
    session.stateVersion = (session.stateVersion || 0) + 1
    session.updatedAt = new Date().toISOString()
    return this.repository.updateSession(session)
  }
}

function cloneTemplate(template: SessionSnapshot['template']) {
  return JSON.parse(JSON.stringify(template)) as SessionSnapshot['template']
}

function isTimedStatus(status: SessionStatus): status is TimedSessionStatus {
  return TIMED_STATUSES.includes(status as TimedSessionStatus)
}

function durationForStatus(status: TimedSessionStatus) {
  if (status === 'countdown') return LIVE_COUNTDOWN_DURATION_MS
  if (status === 'question_open') return LIVE_QUESTION_DURATION_MS
  if (status === 'show_answer') return LIVE_ANSWER_REVEAL_DURATION_MS
  return LIVE_LEADERBOARD_DURATION_MS
}

function dateMs(value: string | null | undefined) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}
