import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildApp } from '../src/app.js'
import { createPlayerToken } from '../src/security/playerToken.js'

test('HTTP player flow authenticates tokens, retries answers, and revokes access', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'izzy-http-auth-'))
  const runtime = await buildApp({
    adminToken: 'test-admin-token',
    corsOrigins: [],
    dataDir,
    logger: false,
  })
  t.after(() => runtime.app.close())
  await runtime.app.ready()

  const session = await runtime.services.sessionService.createSession(runtime.demoTemplate.id)
  const joinResponse = await runtime.app.inject({
    method: 'POST',
    url: `/sessions/${session.code}/join`,
    payload: { name: 'Authenticated Player' },
    remoteAddress: '203.0.113.10',
  })
  assert.equal(joinResponse.statusCode, 201)
  const joined = joinResponse.json()
  assert.match(joined.playerToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(joined.player.name, 'Authenticated Player')
  assert.equal(joined.player.authTokenHash, undefined)
  assert.doesNotMatch(joinResponse.body, /authTokenHash/)

  const publicResponse = await runtime.app.inject({
    method: 'GET',
    url: `/sessions/${session.code}`,
  })
  assert.equal(publicResponse.statusCode, 200)
  assert.doesNotMatch(publicResponse.body, /authTokenHash/)
  assert.doesNotMatch(publicResponse.body, new RegExp(joined.playerToken))

  const authenticatedState = await runtime.app.inject({
    method: 'GET',
    url: `/sessions/${session.code}/player`,
    headers: { authorization: `Bearer ${joined.playerToken}` },
  })
  assert.equal(authenticatedState.statusCode, 200)
  assert.equal(authenticatedState.json().player.id, joined.player.id)

  const invalidState = await runtime.app.inject({
    method: 'GET',
    url: `/sessions/${session.code}/player`,
    headers: { authorization: `Bearer ${createPlayerToken()}` },
  })
  assert.equal(invalidState.statusCode, 401)
  assert.equal(invalidState.json().error, 'Player session is invalid')

  await runtime.services.sessionService.startSession(session.code)
  await runtime.services.sessionService.skipPhase(session.code)
  const state = await runtime.services.sessionService.getSnapshotByCode(session.code)
  assert.ok(state)
  const requestId = randomUUID()
  const optionId = state.template.questions[0]!.correctOptionId
  const answerRequest = {
    method: 'POST' as const,
    url: `/sessions/${session.code}/answer`,
    headers: { authorization: `Bearer ${joined.playerToken}` },
    payload: { optionId, requestId },
    remoteAddress: '203.0.113.10',
  }

  const firstAnswer = await runtime.app.inject(answerRequest)
  assert.equal(firstAnswer.statusCode, 201)
  assert.equal(firstAnswer.json().duplicate, false)
  const repeatedAnswer = await runtime.app.inject(answerRequest)
  assert.equal(repeatedAnswer.statusCode, 200)
  assert.equal(repeatedAnswer.json().duplicate, true)
  assert.equal(repeatedAnswer.json().answer.id, firstAnswer.json().answer.id)

  const persisted = await runtime.services.sessionService.getSnapshotByCode(session.code)
  assert.equal(persisted?.session.answers.length, 1)
  assert.equal(persisted?.session.players[0]?.score, firstAnswer.json().answer.score)

  const revokeResponse = await runtime.app.inject({
    method: 'POST',
    url: `/admin/sessions/${session.code}/players/${joined.player.id}/revoke`,
    headers: { authorization: 'Bearer test-admin-token' },
  })
  assert.equal(revokeResponse.statusCode, 200)

  const revokedState = await runtime.app.inject({
    method: 'GET',
    url: `/sessions/${session.code}/player`,
    headers: { authorization: `Bearer ${joined.playerToken}` },
  })
  assert.equal(revokedState.statusCode, 401)

  for (let attempt = 0; attempt < 74; attempt += 1) {
    const invalidJoin = await runtime.app.inject({
      method: 'POST',
      url: `/sessions/${session.code}/join`,
      payload: { name: '' },
      remoteAddress: '203.0.113.10',
    })
    assert.equal(invalidJoin.statusCode, 400)
  }
  const limitedJoin = await runtime.app.inject({
    method: 'POST',
    url: `/sessions/${session.code}/join`,
    payload: { name: '' },
    remoteAddress: '203.0.113.10',
  })
  assert.equal(limitedJoin.statusCode, 429)
  assert.ok(Number(limitedJoin.headers['retry-after']) > 0)
})
