import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { toHostSessionState, toPlayerSessionState } from '../domain/public.js'
import type { SessionSnapshot } from '../domain/types.js'
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
  const phaseTimers = new Map<string, NodeJS.Timeout>()
  const playerConnections = new Map<string, number>()
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        const isConfiguredOrigin = !origin || deps.corsOrigins.includes(origin)
        const isLocalDevelopmentOrigin = Boolean(
          origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        )

        callback(null, isConfiguredOrigin || isLocalDevelopmentOrigin)
      },
      credentials: true,
    },
  })

  const emitSessionState = async (code: string) => {
    const result = await deps.sessionService.advanceTimedPhases(code)
    const { snapshot } = result
    const publicState = toPlayerSessionState(snapshot.template, snapshot.session)
    const hostState = toHostSessionState(snapshot.template, snapshot.session)

    io.to(sessionRoom(code)).emit('session:state', publicState)
    io.to(hostRoom(code)).emit('host:state', hostState)
    schedulePhaseTimer(snapshot)
  }

  const schedulePhaseTimer = (snapshot: SessionSnapshot) => {
    const code = snapshot.session.code.trim().toUpperCase()
    clearPhaseTimer(code)
    if (!snapshot.session.phaseEndsAt) return

    const remainingMs = Math.max(0, new Date(snapshot.session.phaseEndsAt).getTime() - Date.now())
    const timer = setTimeout(async () => {
      try {
        await emitSessionState(code)
      } catch {
        clearPhaseTimer(code)
      }
    }, remainingMs + 20)

    phaseTimers.set(code, timer)
  }

  const clearPhaseTimer = (code: string) => {
    const normalizedCode = code.trim().toUpperCase()
    const existingTimer = phaseTimers.get(normalizedCode)
    if (!existingTimer) return
    clearTimeout(existingTimer)
    phaseTimers.delete(normalizedCode)
  }

  const resumeSessions = async () => {
    const sessions = await deps.sessionService.listSessions()
    await Promise.all(
      sessions
        .filter((session) => session.status !== 'finished')
        .map(async (session) => emitSessionState(session.code))
    )
  }

  io.on('connection', (socket) => {
    socket.on('host:join', async (payload: { code: string; token: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        assertAdmin(payload.token, deps.adminToken)
        const { snapshot } = await deps.sessionService.advanceTimedPhases(payload.code)
        await socket.join(sessionRoom(payload.code))
        await socket.join(hostRoom(payload.code))
        schedulePhaseTimer(snapshot)
        return toHostSessionState(snapshot.template, snapshot.session)
      })
    })

    socket.on('display:join-room', async (payload: { code: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        const { snapshot } = await deps.sessionService.advanceTimedPhases(payload.code)
        await socket.join(sessionRoom(payload.code))
        schedulePhaseTimer(snapshot)
        return toPlayerSessionState(snapshot.template, snapshot.session)
      })
    })

    socket.on('player:join-room', async (payload: { code: string; playerId: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        const { snapshot } = await deps.sessionService.advanceTimedPhases(payload.code)
        const player = snapshot.session.players.find((candidate) => candidate.id === payload.playerId)
        if (!player) throw new Error('Player not found')

        const normalizedCode = payload.code.trim().toUpperCase()
        const playerKey = `${normalizedCode}:${payload.playerId}`
        socket.data.code = normalizedCode
        socket.data.playerId = payload.playerId
        socket.data.playerKey = playerKey
        playerConnections.set(playerKey, (playerConnections.get(playerKey) || 0) + 1)
        await socket.join(sessionRoom(normalizedCode))
        await deps.sessionService.setPlayerConnection(normalizedCode, payload.playerId, true)
        await emitSessionState(normalizedCode)

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
      deps.sessionService.setLobbyStatus(code, 'lobby_open')
    )
    registerHostAction(socket, 'host:lock-lobby', deps, emitSessionState, (code) =>
      deps.sessionService.setLobbyStatus(code, 'lobby_locked')
    )
    registerHostAction(socket, 'host:start', deps, emitSessionState, (code) => deps.sessionService.startSession(code))
    registerHostAction(socket, 'host:skip-phase', deps, emitSessionState, (code) => deps.sessionService.skipPhase(code))
    registerHostAction(socket, 'host:pause', deps, emitSessionState, (code) => deps.sessionService.pauseSession(code))
    registerHostAction(socket, 'host:resume', deps, emitSessionState, (code) => deps.sessionService.resumeSession(code))
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
      deps.sessionService.finishSession(code)
    )

    socket.on('disconnect', async () => {
      const playerKey = socket.data.playerKey as string | undefined
      const code = socket.data.code as string | undefined
      const playerId = socket.data.playerId as string | undefined
      if (!playerKey || !code || !playerId) return

      const remainingConnections = Math.max(0, (playerConnections.get(playerKey) || 1) - 1)
      if (remainingConnections > 0) {
        playerConnections.set(playerKey, remainingConnections)
        return
      }

      playerConnections.delete(playerKey)
      await deps.sessionService.setPlayerConnection(code, playerId, false)
      await emitSessionState(code)
    })
  })

  return { io, emitSessionState, resumeSessions }
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
      await action(payload.code)
      await emitSessionState(payload.code)
      const { snapshot } = await deps.sessionService.advanceTimedPhases(payload.code)
      return toHostSessionState(snapshot.template, snapshot.session)
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
