import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildApp } from '../src/app.js'

const adminToken = 'upload-test-admin-token'

test('accepts quiz images, serves their content type, and caches them', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'izzy-upload-test-'))
  const runtime = await buildApp({
    adminToken,
    corsOrigins: ['http://localhost:5173'],
    dataDir,
    publicBaseUrl: 'http://quiz.test',
    logger: false,
  })

  try {
    const boundary = '----izzy-upload-boundary'
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="question.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    const upload = await runtime.app.inject({
      method: 'POST',
      url: '/admin/uploads',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })

    assert.equal(upload.statusCode, 201)
    const uploadedUrl = new URL(upload.json().url)
    assert.match(uploadedUrl.pathname, /^\/uploads\/[0-9a-f-]+\.png$/)

    const media = await runtime.app.inject({ method: 'GET', url: uploadedUrl.pathname })
    assert.equal(media.statusCode, 200)
    assert.match(String(media.headers['content-type']), /^image\/png/)
    assert.equal(media.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.deepEqual(media.rawPayload, image)
  } finally {
    await runtime.app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
