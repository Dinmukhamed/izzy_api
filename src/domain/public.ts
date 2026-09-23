import type { GameTemplate, LiveSession, PlayerAnswer, PublicQuestion, Question } from './types.js'
import { LIVE_QUESTION_DURATION_MS } from './constants.js'

export function toPublicQuestion(question: Question, revealAnswer = false): PublicQuestion {
  const { correctOptionId, ...publicQuestion } = question

  const liveQuestion = { ...publicQuestion, durationMs: LIVE_QUESTION_DURATION_MS }

  return revealAnswer ? { ...liveQuestion, correctOptionId } : liveQuestion
}

export function getCurrentQuestion(template: GameTemplate, session: LiveSession) {
  if (session.currentQuestionIndex === null) return null

  return template.questions[session.currentQuestionIndex] || null
}

export function toPlayerSessionState(template: GameTemplate, session: LiveSession) {
  const currentQuestion = getCurrentQuestion(template, session)
  const revealAnswer = ['show_answer', 'leaderboard', 'finished'].includes(session.status)
  const answeredPlayerIds = currentQuestion
    ? session.answers
        .filter((answer) => answer.questionId === currentQuestion.id)
        .map((answer) => answer.playerId)
    : []

  return {
    code: session.code,
    templateTitle: template.title,
    status: session.status,
    players: session.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    })),
    currentQuestion: currentQuestion ? toPublicQuestion(currentQuestion, revealAnswer) : null,
    currentQuestionIndex: session.currentQuestionIndex,
    questionCount: template.questions.length,
    questionStartedAt: session.questionStartedAt,
    phaseEndsAt: session.phaseEndsAt || null,
    serverNow: new Date().toISOString(),
    stateVersion: session.stateVersion || 0,
    answeredPlayerIds,
    answers: revealAnswer ? toPublicAnswers(session.answers) : [],
  }
}

export function toHostSessionState(template: GameTemplate, session: LiveSession) {
  const currentQuestion = getCurrentQuestion(template, session)

  return {
    ...toPlayerSessionState(template, session),
    template,
    currentQuestion: currentQuestion ? toPublicQuestion(currentQuestion, true) : null,
    answers: session.answers,
  }
}

function toPublicAnswers(answers: PlayerAnswer[]) {
  return answers.map((answer) => ({
    id: answer.id,
    playerId: answer.playerId,
    questionId: answer.questionId,
    optionId: answer.optionId,
    isCorrect: answer.isCorrect,
    score: answer.score,
    elapsedMs: answer.elapsedMs,
  }))
}
