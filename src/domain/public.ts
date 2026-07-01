import type { GameTemplate, LiveSession, PlayerAnswer, PublicQuestion, Question } from './types.js'

export function toPublicQuestion(question: Question, revealAnswer = false): PublicQuestion {
  const { correctOptionId, ...publicQuestion } = question

  return revealAnswer ? { ...publicQuestion, correctOptionId } : publicQuestion
}

export function getCurrentQuestion(template: GameTemplate, session: LiveSession) {
  if (session.currentQuestionIndex === null) return null

  return template.questions[session.currentQuestionIndex] || null
}

export function toPlayerSessionState(template: GameTemplate, session: LiveSession) {
  const currentQuestion = getCurrentQuestion(template, session)
  const revealAnswer = session.status === 'show_answer' || session.status === 'finished'

  return {
    code: session.code,
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
    answers: revealAnswer ? toPublicAnswers(session.answers) : [],
  }
}

export function toHostSessionState(template: GameTemplate, session: LiveSession) {
  const currentQuestion = getCurrentQuestion(template, session)

  return {
    ...toPlayerSessionState(template, session),
    template,
    currentQuestion,
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
