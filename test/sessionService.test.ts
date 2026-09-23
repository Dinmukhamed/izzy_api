import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { GameTemplate, LiveSession } from '../src/domain/types.js'
import type { QuizRepository } from '../src/repositories/quizRepository.js'
import { SqliteQuizRepository } from '../src/repositories/sqliteQuizRepository.js'
import { SessionService } from '../src/services/sessionService.js'

const PLAYER_COUNT = 50
const QUESTION_COUNT = 12

test('keeps every answer when 50 players answer concurrently through a full game', async () => {
  const repository = new CloningQuizRepository(1)
  const template = makeTemplate(QUESTION_COUNT)
  await repository.createTemplate(template)
  const service = new SessionService(repository)
  const session = await service.createSession(template.id)

  const joins = await Promise.all(
    Array.from({ length: PLAYER_COUNT }, (_, index) => service.joinSession(session.code, `Player ${index + 1}`))
  )
  const playerIds = joins.map(({ player }) => player.id)
  assert.equal(new Set(playerIds).size, PLAYER_COUNT)

  await service.startSession(session.code)

  for (let questionIndex = 0; questionIndex < QUESTION_COUNT; questionIndex += 1) {
    await service.skipPhase(session.code)
    const beforeAnswers = await service.getSnapshotByCode(session.code)
    assert.ok(beforeAnswers)
    assert.equal(beforeAnswers.session.status, 'question_open')
    assert.equal(beforeAnswers.session.questionPlayerIds?.length, PLAYER_COUNT)

    const question = template.questions[questionIndex]
    assert.ok(question)
    await Promise.all(
      playerIds.map((playerId) => service.submitAnswer(session.code, playerId, question.correctOptionId))
    )

    const afterAnswers = await service.getSnapshotByCode(session.code)
    assert.ok(afterAnswers)
    const questionAnswers = afterAnswers.session.answers.filter((answer) => answer.questionId === question.id)
    assert.equal(questionAnswers.length, PLAYER_COUNT)
    assert.equal(new Set(questionAnswers.map((answer) => answer.playerId)).size, PLAYER_COUNT)
    assert.equal(afterAnswers.session.status, 'show_answer')

    await service.skipPhase(session.code)
    const leaderboard = await service.getSnapshotByCode(session.code)
    assert.equal(leaderboard?.session.status, 'leaderboard')

    await service.skipPhase(session.code)
    const nextPhase = await service.getSnapshotByCode(session.code)
    assert.equal(nextPhase?.session.status, questionIndex === QUESTION_COUNT - 1 ? 'finished' : 'countdown')
  }

  const finished = await service.getSnapshotByCode(session.code)
  assert.ok(finished)
  assert.equal(finished.session.answers.length, PLAYER_COUNT * QUESTION_COUNT)
  assert.equal(finished.session.players.length, PLAYER_COUNT)
  assert.ok(finished.session.players.every((player) => player.score > 0))
})

test('serializes duplicate answers and connection changes', async () => {
  const repository = new CloningQuizRepository(2)
  const template = makeTemplate(1)
  await repository.createTemplate(template)
  const service = new SessionService(repository)
  const session = await service.createSession(template.id)
  const { player } = await service.joinSession(session.code, 'Player')

  await service.startSession(session.code)
  await service.skipPhase(session.code)

  const optionId = template.questions[0]!.correctOptionId
  const results = await Promise.allSettled([
    service.submitAnswer(session.code, player.id, optionId),
    service.submitAnswer(session.code, player.id, optionId),
    service.setPlayerConnection(session.code, player.id, false),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)

  const snapshot = await service.getSnapshotByCode(session.code)
  assert.ok(snapshot)
  assert.equal(snapshot.session.answers.length, 1)
  assert.equal(snapshot.session.players[0]?.connected, false)
})

test('continues a question with its answers after the service restarts', async () => {
  const repository = new CloningQuizRepository(1)
  const template = makeTemplate(2)
  await repository.createTemplate(template)
  const firstService = new SessionService(repository)
  const session = await firstService.createSession(template.id)
  const players = await Promise.all(
    Array.from({ length: PLAYER_COUNT }, (_, index) => firstService.joinSession(session.code, `Restart ${index + 1}`))
  )

  await firstService.startSession(session.code)
  await firstService.skipPhase(session.code)
  await Promise.all(
    players.slice(0, 20).map(({ player }) =>
      firstService.submitAnswer(session.code, player.id, template.questions[0]!.correctOptionId)
    )
  )

  const beforeRestart = await firstService.getSnapshotByCode(session.code)
  assert.ok(beforeRestart)
  assert.equal(beforeRestart.session.status, 'question_open')
  assert.equal(beforeRestart.session.answers.length, 20)
  const originalDeadline = beforeRestart.session.phaseEndsAt

  const restartedService = new SessionService(repository)
  const recovered = await restartedService.advanceTimedPhases(session.code)
  assert.equal(recovered.snapshot.session.status, 'question_open')
  assert.equal(recovered.snapshot.session.answers.length, 20)
  assert.equal(recovered.snapshot.session.phaseEndsAt, originalDeadline)

  await Promise.all(
    players.slice(20).map(({ player }) =>
      restartedService.submitAnswer(session.code, player.id, template.questions[0]!.correctOptionId)
    )
  )
  const completedQuestion = await restartedService.getSnapshotByCode(session.code)
  assert.equal(completedQuestion?.session.answers.length, PLAYER_COUNT)
  assert.equal(completedQuestion?.session.status, 'show_answer')
})

test('persists all 50 concurrent joins and answers in SQLite', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'izzy-api-concurrency-'))
  const repository = new SqliteQuizRepository(join(dataDir, 'izzy.sqlite'))
  const template = makeTemplate(1)
  await repository.createTemplate(template)
  const service = new SessionService(repository)
  const session = await service.createSession(template.id)

  const players = await Promise.all(
    Array.from({ length: PLAYER_COUNT }, (_, index) => service.joinSession(session.code, `SQLite ${index + 1}`))
  )
  await service.startSession(session.code)
  await service.skipPhase(session.code)
  await Promise.all(
    players.map(({ player }) =>
      service.submitAnswer(session.code, player.id, template.questions[0]!.correctOptionId)
    )
  )

  const persisted = await repository.getSessionByCode(session.code)
  assert.ok(persisted)
  assert.equal(persisted.players.length, PLAYER_COUNT)
  assert.equal(persisted.answers.length, PLAYER_COUNT)
  assert.equal(new Set(persisted.answers.map((answer) => answer.playerId)).size, PLAYER_COUNT)
  assert.equal(persisted.status, 'show_answer')
})

class CloningQuizRepository implements QuizRepository {
  private readonly templates = new Map<string, GameTemplate>()
  private readonly sessions = new Map<string, LiveSession>()

  constructor(private readonly writeDelayMs = 0) {}

  async listTemplates() {
    return Array.from(this.templates.values(), clone)
  }

  async getTemplate(id: string) {
    const template = this.templates.get(id)
    return template ? clone(template) : null
  }

  async createTemplate(template: GameTemplate) {
    this.templates.set(template.id, clone(template))
    return clone(template)
  }

  async updateTemplate(template: GameTemplate) {
    this.templates.set(template.id, clone(template))
    return clone(template)
  }

  async deleteTemplate(id: string) {
    this.templates.delete(id)
  }

  async listSessions() {
    return Array.from(this.sessions.values(), clone)
  }

  async getSessionByCode(code: string) {
    const normalizedCode = code.trim().toUpperCase()
    const session = Array.from(this.sessions.values()).find((candidate) => candidate.code === normalizedCode)
    return session ? clone(session) : null
  }

  async getSessionById(id: string) {
    const session = this.sessions.get(id)
    return session ? clone(session) : null
  }

  async createSession(session: LiveSession) {
    this.sessions.set(session.id, clone(session))
    return clone(session)
  }

  async updateSession(session: LiveSession) {
    if (this.writeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs))
    }
    this.sessions.set(session.id, clone(session))
    return clone(session)
  }
}

function makeTemplate(questionCount: number): GameTemplate {
  const now = new Date().toISOString()
  return {
    id: `template-${questionCount}-${Math.random()}`,
    title: 'Concurrency test',
    status: 'active',
    questions: Array.from({ length: questionCount }, (_, questionIndex) => ({
      id: `question-${questionIndex}`,
      kind: 'text' as const,
      text: `Question ${questionIndex + 1}`,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        id: `question-${questionIndex}-option-${optionIndex}`,
        text: `Option ${optionIndex + 1}`,
      })),
      correctOptionId: `question-${questionIndex}-option-0`,
      durationMs: 20_000,
      points: 1_000,
    })),
    createdAt: now,
    updatedAt: now,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
