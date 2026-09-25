import {
  LIVE_ANSWER_REVEAL_DURATION_MS,
  LIVE_COUNTDOWN_DURATION_MS,
  LIVE_LEADERBOARD_DURATION_MS,
  LIVE_QUESTION_DURATION_MS,
  MAX_PLAYERS_PER_SESSION,
} from '../domain/constants.js'
import { AppError, PlayerAuthenticationError } from '../domain/errors.js'
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
import { createPlayerToken, hashPlayerToken, playerTokenMatches } from '../security/playerToken.js'
import { createGameCode, createId } from '../utils/id.js'

const TIMED_STATUSES: TimedSessionStatus[] = ['countdown', 'question_open', 'show_answer', 'leaderboard']

export class SessionService {
  private readonly sessionQueues = new Map<string, Promise<void>>()

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
      await this.withSessionLock(session.code, async () => {
        const snapshot = await this.requireSnapshotUnlocked(session.code)
        if (!snapshot.session.players.some((player) => player.connected)) return
        snapshot.session.players.forEach((player) => { player.connected = false })
        await this.touch(snapshot.session)
      })
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
    return this.withSessionLock(code, () => this.getSnapshotByCodeUnlocked(code))
  }

  private async getSnapshotByCodeUnlocked(code: string): Promise<SessionSnapshot | null> {
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
    return this.withSessionLock(code, () => this.joinSessionUnlocked(code, name))
  }

  private async joinSessionUnlocked(code: string, name: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    const { session } = snapshot

    if (session.status !== 'lobby_open') throw new Error('Lobby is not open')
    if (session.players.length >= MAX_PLAYERS_PER_SESSION) {
      throw new AppError(`The game is full (${MAX_PLAYERS_PER_SESSION} players maximum)`, 409)
    }

    const normalizedName = name.trim()
    const nameExists = session.players.some(
      (player) => player.name.toLowerCase() === normalizedName.toLowerCase()
    )
    if (nameExists) throw new Error('Player name already exists')

    const playerToken = createPlayerToken()
    const player: Player = {
      id: createId(),
      name: normalizedName,
      score: 0,
      joinedAt: new Date().toISOString(),
      connected: true,
      authTokenHash: hashPlayerToken(playerToken),
    }

    session.players.push(player)
    await this.touch(session)

    return { snapshot, player, playerToken }
  }

  async getAuthenticatedPlayerSession(code: string, playerToken: string) {
    return this.withSessionLock(code, async () => {
      const { snapshot, changed } = await this.advanceTimedPhasesUnlocked(code)
      const player = this.requireAuthenticatedPlayer(snapshot.session, playerToken)
      return { snapshot, player, changed }
    })
  }

  async connectPlayer(code: string, playerToken: string, expectedPlayerId?: string) {
    return this.withSessionLock(code, async () => {
      const { snapshot } = await this.advanceTimedPhasesUnlocked(code)
      const player = this.requireAuthenticatedPlayer(snapshot.session, playerToken)
      if (expectedPlayerId && player.id !== expectedPlayerId) throw new PlayerAuthenticationError()
      if (!player.connected) {
        player.connected = true
        await this.touch(snapshot.session)
      }
      return { snapshot, player }
    })
  }

  async revokePlayerAccess(code: string, playerId: string) {
    return this.withSessionLock(code, async () => {
      const snapshot = await this.requireSnapshotUnlocked(code)
      const player = snapshot.session.players.find((candidate) => candidate.id === playerId)
      if (!player) throw new Error('Player not found')
      player.authTokenHash = null
      player.connected = false
      await this.touch(snapshot.session)
      return snapshot
    })
  }

  async setPlayerConnection(code: string, playerId: string, connected: boolean) {
    return this.withSessionLock(code, () => this.setPlayerConnectionUnlocked(code, playerId, connected))
  }

  private async setPlayerConnectionUnlocked(code: string, playerId: string, connected: boolean) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    const player = snapshot.session.players.find((candidate) => candidate.id === playerId)
    if (!player || player.connected === connected) return snapshot

    player.connected = connected
    await this.touch(snapshot.session)
    return snapshot
  }

  async setLobbyStatus(code: string, status: 'lobby_open' | 'lobby_locked') {
    return this.withSessionLock(code, () => this.setLobbyStatusUnlocked(code, status))
  }

  private async setLobbyStatusUnlocked(code: string, status: 'lobby_open' | 'lobby_locked') {
    const snapshot = await this.requireSnapshotUnlocked(code)
    if (!['lobby_open', 'lobby_locked'].includes(snapshot.session.status)) {
      throw new Error('Lobby can only be changed before the game starts')
    }

    snapshot.session.status = status
    await this.touch(snapshot.session)
    return snapshot
  }

  async setStatus(code: string, status: Extract<SessionStatus, 'lobby_open' | 'lobby_locked' | 'finished'>) {
    return this.withSessionLock(code, () => {
      if (status === 'finished') return this.finishSessionUnlocked(code)
      return this.setLobbyStatusUnlocked(code, status)
    })
  }

  async startSession(code: string) {
    return this.withSessionLock(code, () => this.startSessionUnlocked(code))
  }

  private async startSessionUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
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
    return this.withSessionLock(code, () => this.openNextQuestionUnlocked(code))
  }

  private async openNextQuestionUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    const { session, template } = snapshot

    if (!['show_answer', 'leaderboard', 'question_closed'].includes(session.status)) {
      throw new Error('The next question is not available in the current phase')
    }

    const nextIndex = session.currentQuestionIndex === null ? 0 : session.currentQuestionIndex + 1
    if (!template.questions[nextIndex]) return this.finishSessionUnlocked(code)

    session.currentQuestionIndex = nextIndex
    this.enterCountdown(session, Date.now())
    await this.touch(session)
    return snapshot
  }

  async closeQuestion(code: string) {
    return this.withSessionLock(code, () => this.showAnswerUnlocked(code))
  }

  async showAnswer(code: string) {
    return this.withSessionLock(code, () => this.showAnswerUnlocked(code))
  }

  private async showAnswerUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    if (!['question_open', 'question_closed'].includes(snapshot.session.status)) {
      throw new Error('There is no open question to reveal')
    }

    this.enterAnswerReveal(snapshot.session, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async showAnswerIfCurrentQuestion(code: string, questionId: string) {
    return this.withSessionLock(code, () => this.showAnswerIfCurrentQuestionUnlocked(code, questionId))
  }

  private async showAnswerIfCurrentQuestionUnlocked(code: string, questionId: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    const currentQuestion = getCurrentQuestion(snapshot.template, snapshot.session)

    if (snapshot.session.status !== 'question_open' || currentQuestion?.id !== questionId) return snapshot

    this.enterAnswerReveal(snapshot.session, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async showAnswerIfEveryoneAnswered(code: string, questionId: string) {
    return this.withSessionLock(code, () => this.showAnswerIfEveryoneAnsweredUnlocked(code, questionId))
  }

  private async showAnswerIfEveryoneAnsweredUnlocked(code: string, questionId: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
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
    return this.withSessionLock(code, () => this.pauseSessionUnlocked(code))
  }

  private async pauseSessionUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
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
    return this.withSessionLock(code, () => this.resumeSessionUnlocked(code))
  }

  private async resumeSessionUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
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
    return this.withSessionLock(code, () => this.skipPhaseUnlocked(code))
  }

  private async skipPhaseUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    if (!isTimedStatus(snapshot.session.status)) throw new Error('There is no timed phase to skip')

    this.advanceOnePhase(snapshot, Date.now())
    await this.touch(snapshot.session)
    return snapshot
  }

  async finishSession(code: string) {
    return this.withSessionLock(code, () => this.finishSessionUnlocked(code))
  }

  private async finishSessionUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
    snapshot.session.status = 'finished'
    snapshot.session.phaseEndsAt = null
    snapshot.session.pausedPhase = null
    snapshot.session.pausedRemainingMs = null
    await this.touch(snapshot.session)
    return snapshot
  }

  async advanceTimedPhases(code: string) {
    return this.withSessionLock(code, () => this.advanceTimedPhasesUnlocked(code))
  }

  private async advanceTimedPhasesUnlocked(code: string) {
    const snapshot = await this.requireSnapshotUnlocked(code)
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

  async submitAnswer(
    code: string,
    playerToken: string,
    optionId: string,
    requestId: string,
    expectedPlayerId?: string
  ) {
    return this.withSessionLock(code, () =>
      this.submitAnswerUnlocked(code, playerToken, optionId, requestId, expectedPlayerId)
    )
  }

  private async submitAnswerUnlocked(
    code: string,
    playerToken: string,
    optionId: string,
    requestId: string,
    expectedPlayerId?: string
  ) {
    const { snapshot } = await this.advanceTimedPhasesUnlocked(code)
    const { session, template } = snapshot
    const player = this.requireAuthenticatedPlayer(session, playerToken)
    if (expectedPlayerId && player.id !== expectedPlayerId) throw new PlayerAuthenticationError()

    const requestAnswer = session.answers.find((answer) => answer.requestId === requestId)
    if (requestAnswer) {
      if (requestAnswer.playerId !== player.id || requestAnswer.optionId !== optionId) {
        throw new AppError('Answer request conflicts with an earlier request', 409)
      }
      return { snapshot, answer: requestAnswer, duplicate: true }
    }

    if (session.status !== 'question_open') throw new Error('Question is not open')
    if (!session.phaseEndsAt || dateMs(session.phaseEndsAt) <= Date.now()) throw new Error('Time is up')

    const question = getCurrentQuestion(template, session)
    if (!question) throw new Error('Question not found')
    if (!question.options.some((option) => option.id === optionId)) throw new Error('Answer option not found')

    const alreadyAnswered = session.answers.find(
      (answer) => answer.playerId === player.id && answer.questionId === question.id
    )
    if (alreadyAnswered) return { snapshot, answer: alreadyAnswered, duplicate: true }

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
      requestId,
      playerId: player.id,
      questionId: question.id,
      optionId,
      isCorrect,
      score,
      elapsedMs,
      answeredAt: new Date(answeredAtMs).toISOString(),
    }

    player.score += score
    session.answers.push(answer)

    const participantIds = session.questionPlayerIds?.length
      ? session.questionPlayerIds
      : session.players.map((candidate) => candidate.id)
    const answeredPlayerIds = new Set(
      session.answers
        .filter((candidate) => candidate.questionId === question.id)
        .map((candidate) => candidate.playerId)
    )
    if (participantIds.length > 0 && participantIds.every((participantId) => answeredPlayerIds.has(participantId))) {
      this.enterAnswerReveal(session, answeredAtMs)
    }

    await this.touch(session)
    return { snapshot, answer, duplicate: false }
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

  private async requireSnapshotUnlocked(code: string) {
    const snapshot = await this.getSnapshotByCodeUnlocked(code)
    if (!snapshot) throw new Error('Session not found')
    return snapshot
  }

  private requireAuthenticatedPlayer(session: LiveSession, playerToken: string) {
    const player = session.players.find((candidate) => playerTokenMatches(playerToken, candidate.authTokenHash))
    if (!player) throw new PlayerAuthenticationError()
    return player
  }

  private async withSessionLock<T>(code: string, action: () => Promise<T>): Promise<T> {
    const normalizedCode = code.trim().toUpperCase()
    const previous = this.sessionQueues.get(normalizedCode) || Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })

    this.sessionQueues.set(normalizedCode, current)
    await previous

    try {
      return await action()
    } finally {
      releaseCurrent()
      if (this.sessionQueues.get(normalizedCode) === current) {
        this.sessionQueues.delete(normalizedCode)
      }
    }
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
