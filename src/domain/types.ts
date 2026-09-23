export type Id = string

export type QuestionKind = 'text' | 'image' | 'audio'

export type GameTemplateStatus = 'draft' | 'active' | 'archived'

export type SessionStatus =
  | 'lobby_open'
  | 'lobby_locked'
  | 'in_progress'
  | 'countdown'
  | 'question_open'
  | 'question_closed'
  | 'show_answer'
  | 'leaderboard'
  | 'paused'
  | 'finished'

export type TimedSessionStatus = 'countdown' | 'question_open' | 'show_answer' | 'leaderboard'

export type Media = {
  type: Exclude<QuestionKind, 'text'>
  url: string
}

export type AnswerOption = {
  id: Id
  text: string
}

export type Question = {
  id: Id
  kind: QuestionKind
  text: string
  media?: Media
  options: AnswerOption[]
  correctOptionId: Id
  durationMs: number
  points: number
}

export type GameTemplate = {
  id: Id
  title: string
  status: GameTemplateStatus
  questions: Question[]
  createdAt: string
  updatedAt: string
}

export type Player = {
  id: Id
  name: string
  score: number
  joinedAt: string
  connected: boolean
}

export type PlayerAnswer = {
  id: Id
  playerId: Id
  questionId: Id
  optionId: Id
  isCorrect: boolean
  score: number
  answeredAt: string
  elapsedMs: number
}

export type LiveSession = {
  id: Id
  code: string
  templateId: Id
  templateSnapshot?: GameTemplate
  status: SessionStatus
  players: Player[]
  answers: PlayerAnswer[]
  currentQuestionIndex: number | null
  questionStartedAt: string | null
  phaseEndsAt?: string | null
  pausedPhase?: TimedSessionStatus | null
  pausedRemainingMs?: number | null
  questionPlayerIds?: Id[]
  stateVersion?: number
  createdAt: string
  updatedAt: string
}

export type PublicQuestion = Omit<Question, 'correctOptionId'> & {
  correctOptionId?: Id
}

export type SessionSnapshot = {
  session: LiveSession
  template: GameTemplate
}
