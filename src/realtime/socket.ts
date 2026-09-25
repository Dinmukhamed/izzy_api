import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { toHostSessionState, toPlayerSessionState, toPublicPlayer } from '../domain/public.js'
import { PlayerAuthenticationError } from '../domain/errors.js'
import type { SessionSnapshot } from '../domain/types.js'
import { getClientAddress } from '../security/clientAddress.js'
import { playerTokenFingerprint } from '../security/playerToken.js'
import type { RateLimiter } from '../security/rateLimiter.js'
import type { SessionService } from '../services/sessionService.js'
import { answerSchema, gameCodeSchema, playerTokenSchema } from '../validation/schemas.js'

type RealtimeDeps = {
  adminToken: string
  corsOrigins: string[]
  sessionService: SessionService
  rateLimiter: RateLimiter
}

type ClientAck<T = unknown> = (response: { ok: true; data: T } | { ok: false; error: string }) => void

const sessionRoom = (code: string) => `session:${code.trim().toUpperCase()}`
const hostRoom = (code: string) => `host:${code.trim().toUpperCase()}`

export function createRealtimeServer(httpServer: HttpServer, deps: RealtimeDeps) {
  const phaseTimers = new Map<string, NodeJS.Timeout>()
  const playerConnections = new Map<string, number>()
  let isClosing = false
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
    if (isClosing) return
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

    socket.on('player:join-room', async (payload: { code: string; playerToken: string }, ack?: ClientAck) => {
      await safely(ack, async () => {
        const clientAddress = getClientAddress(socket.handshake.headers['x-forwarded-for'], socket.handshake.address)
        deps.rateLimiter.consume({ bucket: 'socket-player-event-ip', key: clientAddress, limit: 600, windowMs: 60_000 })
        const code = gameCodeSchema.parse(payload.code)
        const playerToken = requirePlayerToken(payload.playerToken)
        deps.rateLimiter.consume(
          { bucket: 'socket-join-ip-code', key: `${clientAddress}:${code}`, limit: 300, windowMs: 60_000 },
          { bucket: 'socket-join-token', key: playerTokenFingerprint(playerToken), limit: 20, windowMs: 60_000 }
        )
        const previousPlayerKey = socket.data.playerKey as string | undefined
        const previousPlayerId = socket.data.playerId as string | undefined
        const { snapshot, player } = await deps.sessionService.connectPlayer(code, playerToken, previousPlayerId)
        const playerKey = `${code}:${player.id}`
        socket.data.code = code
        socket.data.playerId = player.id
        socket.data.playerKey = playerKey
        if (!previousPlayerKey) playerConnections.set(playerKey, (playerConnections.get(playerKey) || 0) + 1)
        await socket.join(sessionRoom(code))
        await emitSessionState(code)

        return {
          player: toPublicPlayer(player),
          state: toPlayerSessionState(snapshot.template, snapshot.session),
        }
      })
    })

    socket.on('player:answer', async (
      payload: { code: string; playerToken: string; optionId: string; requestId: string },
      ack?: ClientAck
    ) => {
      await safely(ack, async () => {
        const authenticatedPlayerId = socket.data.playerId as string | undefined
        if (!authenticatedPlayerId) throw new PlayerAuthenticationError()
        const clientAddress = getClientAddress(socket.handshake.headers['x-forwarded-for'], socket.handshake.address)
        deps.rateLimiter.consume({ bucket: 'socket-player-event-ip', key: clientAddress, limit: 600, windowMs: 60_000 })
        const code = gameCodeSchema.parse(payload.code)
        const playerToken = requirePlayerToken(payload.playerToken)
        const answerInput = answerSchema.parse(payload)
        deps.rateLimiter.consume(
          { bucket: 'socket-answer-ip-code', key: `${clientAddress}:${code}`, limit: 400, windowMs: 60_000 },
          { bucket: 'socket-answer-token', key: playerTokenFingerprint(playerToken), limit: 30, windowMs: 60_000 }
        )
        const { answer, duplicate } = await deps.sessionService.submitAnswer(
          code,
          playerToken,
          answerInput.optionId,
          answerInput.requestId,
          authenticatedPlayerId
        )
        if (!duplicate) await emitSessionState(code)
        return { answer, duplicate }
      })
    })

    socket.on('host:revoke-player', async (
      payload: { code: string; token: string; playerId: string },
      ack?: ClientAck
    ) => {
      await safely(ack, async () => {
        assertAdmin(payload.token, deps.adminToken)
        if (!payload.playerId || typeof payload.playerId !== 'string') throw new Error('Player is required')
        const snapshot = await deps.sessionService.revokePlayerAccess(payload.code, payload.playerId)
        await emitSessionState(payload.code)
        return toHostSessionState(snapshot.template, snapshot.session)
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
      if (isClosing) return
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

  const close = async () => {
    if (isClosing) return
    isClosing = true
    for (const timer of phaseTimers.values()) clearTimeout(timer)
    phaseTimers.clear()
    playerConnections.clear()
    await new Promise<void>((resolve) => io.close(() => resolve()))
  }

  return { io, emitSessionState, resumeSessions, close }
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

function requirePlayerToken(value: unknown) {
  const parsed = playerTokenSchema.safeParse(value)
  if (!parsed.success) throw new PlayerAuthenticationError()
  return parsed.data
}
