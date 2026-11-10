import assert from 'node:assert/strict'
import test from 'node:test'
import { toPlayerSessionState } from '../src/domain/public.js'
import type { GameTemplate, LiveSession, SessionStatus } from '../src/domain/types.js'

const template: GameTemplate = {
  id: 'template-1',
  title: 'Safe public state',
  status: 'active',
  questions: [
    {
      id: 'question-1',
      kind: 'image',
      text: 'Previous question',
      media: { type: 'image', url: 'https://example.test/uploads/question-1.webp' },
      options: [{ id: 'q1-a', text: 'A' }, { id: 'q1-b', text: 'B' }, { id: 'q1-c', text: 'C' }, { id: 'q1-d', text: 'D' }],
      correctOptionId: 'q1-a',
      durationMs: 20_000,
      points: 1_000,
    },
    {
      id: 'question-2',
      kind: 'image',
      text: 'Current question',
      media: { type: 'image', url: 'https://example.test/uploads/question-1.webp' },
      options: [{ id: 'q2-a', text: 'A' }, { id: 'q2-b', text: 'B' }, { id: 'q2-c', text: 'C' }, { id: 'q2-d', text: 'D' }],
      correctOptionId: 'q2-b',
      durationMs: 20_000,
      points: 1_000,
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const baseSession: LiveSession = {
  id: 'session-1',
  code: 'SAFE01',
  templateId: template.id,
  status: 'question_open',
  players: [
    { id: 'player-1', name: 'Player 1', score: 1_800, joinedAt: '2026-01-01T00:00:00.000Z', connected: true },
    { id: 'player-2', name: 'Player 2', score: 400, joinedAt: '2026-01-01T00:00:00.000Z', connected: true },
  ],
  answers: [
    { id: 'answer-1', playerId: 'player-1', questionId: 'question-1', optionId: 'q1-a', isCorrect: true, score: 1_000, answeredAt: '2026-01-01T00:00:01.000Z', elapsedMs: 1_000 },
    { id: 'answer-2', playerId: 'player-1', questionId: 'question-2', optionId: 'q2-b', isCorrect: true, score: 800, answeredAt: '2026-01-01T00:00:02.000Z', elapsedMs: 4_000 },
    { id: 'answer-3', playerId: 'player-2', questionId: 'question-2', optionId: 'q2-a', isCorrect: false, score: 0, answeredAt: '2026-01-01T00:00:03.000Z', elapsedMs: 6_000 },
  ],
  currentQuestionIndex: 1,
  questionStartedAt: '2026-01-01T00:00:00.000Z',
  phaseEndsAt: '2026-01-01T00:00:20.000Z',
  stateVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:03.000Z',
}

test('hides current-question results and score changes in every unrevealed phase', () => {
  const phases: Array<{ status: SessionStatus; pausedPhase?: LiveSession['pausedPhase'] }> = [
    { status: 'question_open' },
    { status: 'question_closed' },
    { status: 'paused', pausedPhase: 'question_open' },
  ]

  for (const phase of phases) {
    const state = toPlayerSessionState(template, { ...baseSession, ...phase })
    assert.equal(state.players.find((player) => player.id === 'player-1')?.score, 1_000)
    assert.equal(state.players.find((player) => player.id === 'player-2')?.score, 400)
    assert.equal(state.currentQuestion?.correctOptionId, undefined)
    assert.deepEqual(state.answers, [])
    assert.deepEqual(state.preloadImageUrls, ['https://example.test/uploads/question-1.webp'])
  }
})

test('reveals current-question results only in reveal, leaderboard, and finished phases', () => {
  const phases: Array<{ status: SessionStatus; pausedPhase?: LiveSession['pausedPhase'] }> = [
    { status: 'show_answer' },
    { status: 'leaderboard' },
    { status: 'paused', pausedPhase: 'show_answer' },
    { status: 'finished' },
  ]

  for (const phase of phases) {
    const state = toPlayerSessionState(template, { ...baseSession, ...phase })
    assert.equal(state.players.find((player) => player.id === 'player-1')?.score, 1_800)
    assert.equal(state.currentQuestion?.correctOptionId, 'q2-b')
    assert.equal(state.answers.length, 3)
  }
})
