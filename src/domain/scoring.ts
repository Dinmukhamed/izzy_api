export function calculateAnswerScore(params: {
  isCorrect: boolean
  elapsedMs: number
  durationMs: number
  maxPoints: number
}) {
  if (!params.isCorrect) return 0

  const safeDuration = Math.max(params.durationMs, 1)
  const clampedElapsed = Math.min(Math.max(params.elapsedMs, 0), safeDuration)
  const timeLeftRatio = (safeDuration - clampedElapsed) / safeDuration
  const baseScore = Math.round(params.maxPoints * timeLeftRatio)

  return Math.max(100, baseScore)
}
