import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readLimitedRequestBody,
} from '../../lib/security/read-limited-request-body.ts'
import { parsePositiveIntegerEnv } from '../../lib/env.ts'

test('readLimitedRequestBody rejects declared oversized bodies before reading', async () => {
  const request = new Request('https://ims.example.com/webhook', {
    method: 'POST',
    headers: { 'content-length': '9' },
    body: 'small',
  })

  const result = await readLimitedRequestBody(request, { maxBytes: 4 })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.response.status, 413)
    assert.deepEqual(await result.response.json(), { error: 'Request body is too large.' })
  }
})

test('readLimitedRequestBody rejects streamed bodies that exceed the byte limit', async () => {
  const request = new Request('https://ims.example.com/webhook', {
    method: 'POST',
    body: '12345',
  })

  const result = await readLimitedRequestBody(request, { maxBytes: 4 })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.response.status, 413)
})

test('readLimitedRequestBody uses an inclusive byte cap', async () => {
  const exact = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', { method: 'POST', body: '1234' }),
    { maxBytes: 4 },
  )
  assert.equal(exact.ok, true)
  if (exact.ok) assert.equal(exact.body, '1234')

  const over = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', { method: 'POST', body: '12345' }),
    { maxBytes: 4 },
  )
  assert.equal(over.ok, false)
  if (!over.ok) assert.equal(over.response.status, 413)
})

test('readLimitedRequestBody cancels a multi-chunk stream on overflow', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12'))
      controller.enqueue(new TextEncoder().encode('345'))
    },
    cancel() {
      cancelled = true
    },
  })

  const result = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
    { maxBytes: 4 },
  )

  assert.equal(result.ok, false)
  assert.equal(cancelled, true)
  if (!result.ok) assert.equal(result.response.status, 413)
})

test('readLimitedRequestBody validates Content-Length headers', async () => {
  const overflow = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      headers: { 'content-length': '9999999999999999999999' },
      body: '1',
    }),
    { maxBytes: 100 },
  )
  assert.equal(overflow.ok, false)
  if (!overflow.ok) assert.equal(overflow.response.status, 413)

  const duplicateEqual = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      headers: { 'content-length': '4, 4' },
      body: '1234',
    }),
    { maxBytes: 4 },
  )
  assert.equal(duplicateEqual.ok, true)

  const duplicateMismatch = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      headers: { 'content-length': '4, 5' },
      body: '1234',
    }),
    { maxBytes: 10 },
  )
  assert.equal(duplicateMismatch.ok, false)
  if (!duplicateMismatch.ok) assert.equal(duplicateMismatch.response.status, 400)
})

test('readLimitedRequestBody rejects declared empty bodies unless explicitly allowed', async () => {
  const result = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      headers: { 'content-length': '0' },
      body: '',
    }),
    { maxBytes: 100 },
  )

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.response.status, 400)
})

test('readLimitedRequestBody decodes malformed UTF-8 with replacement semantics', async () => {
  const result = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      body: new Uint8Array([0xff]),
    }),
    { maxBytes: 100 },
  )

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.body, '\uFFFD')
})

test('readLimitedRequestBody validates maxBytes', async () => {
  await assert.rejects(
    () => readLimitedRequestBody(
      new Request('https://ims.example.com/webhook', { method: 'POST', body: '1' }),
      { maxBytes: 0 },
    ),
    /maxBytes must be a positive integer/,
  )
})

test('readLimitedRequestBody rejects empty bodies unless explicitly allowed', async () => {
  const rejected = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', { method: 'POST', body: '' }),
    { maxBytes: 100 },
  )
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.response.status, 400)

  const accepted = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', { method: 'POST', body: '' }),
    { maxBytes: 100, emptyBodyAllowed: true },
  )
  assert.deepEqual(accepted, { ok: true, body: '', byteLength: 0 })
})

test('readLimitedRequestBody returns raw text without logging or parsing it', async () => {
  const result = await readLimitedRequestBody(
    new Request('https://ims.example.com/webhook', {
      method: 'POST',
      body: '{"sku":"A&B #1"}',
    }),
    { maxBytes: 100 },
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.body, '{"sku":"A&B #1"}')
    assert.equal(result.byteLength, Buffer.byteLength(result.body))
  }
})

test('parsePositiveIntegerEnv falls back for missing or unsafe values', () => {
  assert.equal(parsePositiveIntegerEnv(undefined, 42), 42)
  assert.equal(parsePositiveIntegerEnv('0', 42), 42)
  assert.equal(parsePositiveIntegerEnv('30000 abc', 42), 42)
  // Negative values miss the unsigned digit pattern and therefore fall back.
  assert.equal(parsePositiveIntegerEnv('-1', 42), 42)
  assert.equal(parsePositiveIntegerEnv('abc', 42), 42)
  assert.equal(parsePositiveIntegerEnv('64', 42), 64)
})
