import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { io, type Socket } from 'socket.io-client'
import { buildApp } from '../src/app.js'
import { createPlayerToken } from '../src/security/playerToken.js'

const PLAYER_COUNT = 50

test('50 authenticated Socket.IO players answer concurrently without duplicates', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'izzy-socket-auth-'))
  const runtime = await buildApp({
    adminToken: 'test-admin-token',
    corsOrigins: [],
    dataDir,
    logger: false,
  })
  await runtime.app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Socket[] = []
  t.after(async () => {
    await runtime.app.close()
    clients.forEach((client) => client.disconnect())
  })

  const address = runtime.app.server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const session = await runtime.services.sessionService.createSession(runtime.demoTemplate.id)
  const joined = await Promise.all(
    Array.from({ length: PLAYER_COUNT }, (_, index) =>
      runtime.services.sessionService.joinSession(session.code, `Socket Player ${index + 1}`)
    )
  )

  clients.push(...await Promise.all(joined.map(() => connectClient(baseUrl))))

  const invalidJoin = await emitAck(clients[0]!, 'player:join-room', {
    code: session.code,
    playerToken: createPlayerToken(),
  })
  assert.equal(invalidJoin.ok, false)
  if (!invalidJoin.ok) assert.equal(invalidJoin.error, 'Player session is invalid')

  const roomStates = await Promise.all(
    clients.map((client, index) => emitAck(client, 'player:join-room', {
      code: session.code,
      playerToken: joined[index]!.playerToken,
    }))
  )
  assert.ok(roomStates.every((response) => response.ok))
  assert.ok(roomStates.every((response) => !response.ok || response.data.player.authTokenHash === undefined))

  await runtime.services.sessionService.startSession(session.code)
  await runtime.services.sessionService.skipPhase(session.code)
  await runtime.realtime.emitSessionState(session.code)
  const snapshot = await runtime.services.sessionService.getSnapshotByCode(session.code)
  assert.ok(snapshot)
  const optionId = snapshot.template.questions[0]!.correctOptionId
  const requestIds = Array.from({ length: PLAYER_COUNT }, () => randomUUID())

  const switchedIdentity = await emitAck(clients[0]!, 'player:answer', {
    code: session.code,
    playerToken: joined[1]!.playerToken,
    optionId,
    requestId: randomUUID(),
  })
  assert.equal(switchedIdentity.ok, false)
  if (!switchedIdentity.ok) assert.equal(switchedIdentity.error, 'Player session is invalid')

  const answerResponses = await Promise.all(
    clients.map((client, index) => emitAck(client, 'player:answer', {
      code: session.code,
      playerToken: joined[index]!.playerToken,
      optionId,
      requestId: requestIds[index],
    }, 10_000))
  )
  assert.ok(answerResponses.every((response) => response.ok))
  assert.ok(answerResponses.every((response) => !response.ok || response.data.duplicate === false))

  const repeated = await emitAck(clients[0]!, 'player:answer', {
    code: session.code,
    playerToken: joined[0]!.playerToken,
    optionId,
    requestId: requestIds[0],
  })
  assert.equal(repeated.ok, true)
  if (repeated.ok) assert.equal(repeated.data.duplicate, true)

  const persisted = await runtime.services.sessionService.getSnapshotByCode(session.code)
  assert.ok(persisted)
  assert.equal(persisted.session.players.length, PLAYER_COUNT)
  assert.equal(persisted.session.answers.length, PLAYER_COUNT)
  assert.equal(new Set(persisted.session.answers.map((answer) => answer.playerId)).size, PLAYER_COUNT)
  assert.equal(new Set(persisted.session.answers.map((answer) => answer.requestId)).size, PLAYER_COUNT)
})

async function connectClient(baseUrl: string) {
  const socket = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 5_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return socket
}

type AckResponse =
  | { ok: true; data: any }
  | { ok: false; error: string }

function emitAck(socket: Socket, event: string, payload: unknown, timeoutMs = 5_000) {
  return new Promise<AckResponse>((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response?: AckResponse) => {
      if (error) return reject(error)
      if (!response) return reject(new Error(`${event} returned no acknowledgement`))
      resolve(response)
    })
  })
}
