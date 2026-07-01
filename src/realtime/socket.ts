import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { toHostSessionState, toPlayerSessionState } from '../domain/public.js'
import type { SessionService } from '../services/sessionService.js'

type RealtimeDeps = {
  adminToken: string
  corsOrigins: string[]
  sessionService: SessionService
}

type ClientAck<T = unknown> = (response: { ok: true; data: T } | { ok: false; error: string }) => void

const sessionRoom = (code: string) => `session:${code.trim().toUpperCase()}`
const hostRoom = (code: string) => `host:${code.trim().toUpperCase()}`

export function createRealtimeServer(httpServer: HttpServer, deps: RealtimeDeps) {
  const questionTimers = new Map<string, NodeJS.Timeout>()
  const io = new Server(httpServer, {
    cors: {
      origin: deps.corsOrigins,
      credentials: true,
    },
  })

  const emitSessionState = async (code: string) => {
    const snapshot = await deps.sessionService.getSnapshotByCode(code)
    if (!snapshot) return

    const publicState = toPlayerSessionState(snapshot.template, snapshot.session)
    const hostState = toHostSessionState(snapshot.template, snapshot.session)

    io.to(sessionRoom(code)).emit('session:state', publicState)
    io.to(hostRoom(code)).emit('host:state', hostState)
    scheduleQuestionTimer(snapshot.session.code)
  }

  io.on('connection', (socket) => {
    socket.on('host:join', async (payload: { code: string; token: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        assertAdmin(payload.token, deps.adminToken)
        const snapshot = await deps.sessionService.getSnapshotByCode(payload.code)
        if (!snapshot) throw new Error('Session not found')

        await socket.join(sessionRoom(payload.code))
        await socket.join(hostRoom(payload.code))

        return toHostSessionState(snapshot.template, snapshot.session)
      })
    })

    socket.on('player:join-room', async (payload: { code: string; playerId: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        const snapshot = await deps.sessionService.getSnapshotByCode(payload.code)
        const player = snapshot?.session.players.find((candidate) => candidate.id === payload.playerId)
        if (!snapshot || !player) throw new Error('Player not found')

        socket.data.code = payload.code
        socket.data.playerId = payload.playerId
        await socket.join(sessionRoom(payload.code))
        await deps.sessionService.setPlayerConnection(payload.code, payload.playerId, true)
        await emitSessionState(payload.code)

        return toPlayerSessionState(snapshot.template, snapshot.session)
      })
    })

    socket.on('player:answer', async (payload: { code: string; playerId: string; optionId: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        const { answer } = await deps.sessionService.submitAnswer(payload.code, payload.playerId, payload.optionId)
        await emitSessionState(payload.code)

        return answer
      })
    })

    registerHostAction(socket, 'host:open-lobby', deps, emitSessionState, (code) =>
      deps.sessionService.setStatus(code, 'lobby_open')
    )
    registerHostAction(socket, 'host:lock-lobby', deps, emitSessionState, (code) =>
      deps.sessionService.setStatus(code, 'lobby_locked')
    )
    registerHostAction(socket, 'host:start', deps, emitSessionState, (code) => deps.sessionService.startSession(code))
    registerHostAction(socket, 'host:next-question', deps, emitSessionState, (code) =>
      deps.sessionService.openNextQuestion(code)
    )
    registerHostAction(socket, 'host:close-question', deps, emitSessionState, (code) =>
      deps.sessionService.closeQuestion(code)
    )
    registerHostAction(socket, 'host:show-answer', deps, emitSessionState, (code) =>
      deps.sessionService.showAnswer(code)
    )
    registerHostAction(socket, 'host:finish', deps, emitSessionState, (code) =>
      deps.sessionService.setStatus(code, 'finished')
    )

    socket.on('disconnect', async () => {
      if (!socket.data.code || !socket.data.playerId) return

      await deps.sessionService.setPlayerConnection(socket.data.code, socket.data.playerId, false)
      await emitSessionState(socket.data.code)
    })
  })

  const scheduleQuestionTimer = async (code: string) => {
    const normalizedCode = code.trim().toUpperCase()
    const snapshot = await deps.sessionService.getSnapshotByCode(normalizedCode)
    const currentQuestion = snapshot?.session.currentQuestionIndex === null
      ? null
      : snapshot?.template.questions[snapshot.session.currentQuestionIndex]

    if (!snapshot || !currentQuestion || snapshot.session.status !== 'question_open' || !snapshot.session.questionStartedAt) {
      clearQuestionTimer(normalizedCode)
      return
    }

    clearQuestionTimer(normalizedCode)

    const startedAt = new Date(snapshot.session.questionStartedAt).getTime()
    const remainingMs = Math.max(0, startedAt + currentQuestion.durationMs - Date.now())

    const timer = setTimeout(async () => {
      await deps.sessionService.showAnswerIfCurrentQuestion(normalizedCode, currentQuestion.id)
      await emitSessionState(normalizedCode)
    }, remainingMs)

    questionTimers.set(normalizedCode, timer)
  }

  const clearQuestionTimer = (code: string) => {
    const normalizedCode = code.trim().toUpperCase()
    const existingTimer = questionTimers.get(normalizedCode)
    if (!existingTimer) return

    clearTimeout(existingTimer)
    questionTimers.delete(normalizedCode)
  }

  return { io, emitSessionState }
}

function registerHostAction(
  socket: Socket,
  event: string,
  deps: RealtimeDeps,
  emitSessionState: (code: string) => Promise<void>,
  action: (code: string) => Promise<unknown>
) {
  socket.on(event, async (payload: { code: string; token: string }, ack?: ClientAck) => {
    await safely(ack, async () => {
      assertAdmin(payload.token, deps.adminToken)
      const result = await action(payload.code)
      await emitSessionState(payload.code)

      return result
    })
  })
}

async function safely<T>(ack: ClientAck<T> | undefined, action: () => Promise<T>) {
  try {
    const data = await action()
    ack?.({ ok: true, data })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong'
    ack?.({ ok: false, error: message })
  }
}

function assertAdmin(token: string | undefined, adminToken: string) {
  if (!token || token !== adminToken) throw new Error('Unauthorized')
}
