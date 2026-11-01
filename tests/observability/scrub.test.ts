import assert from 'node:assert/strict'
import test from 'node:test'

import type { Breadcrumb, Event } from '@sentry/nextjs'

import { scrubBreadcrumb, scrubEvent, scrubSpan } from '@/lib/observability/scrub'

const json = (v: unknown) => JSON.stringify(v)

test('strips auth query param', () => {
  const out = scrubEvent({ message: 'redis down tcp://10.0.3.11:6379?auth=hunter2' })
  assert.ok(out)
  assert.doesNotMatch(json(out), /hunter2/)
  assert.match(out.message ?? '', /10\.0\.3\.11:6379/)
})

test('strips Authorization header', () => {
  const out = scrubEvent({
    request: {
      url: 'https://ims.example/api/x',
      headers: { Authorization: 'Bearer abc.def.ghi', 'x-api-key': 'k-12345', accept: 'text/html' },
      cookies: { session: 'cookie-secret-1' },
      query_string: 'token=qs-secret-2&page=2',
      data: { password: 'pw-secret-3', name: 'Widget' },
    },
    message: 'Authorization: Basic dXNlcjpwYXNz failed',
  })
  assert.ok(out)
  const s = json(out)
  for (const leaked of ['abc.def.ghi', 'k-12345', 'cookie-secret-1', 'qs-secret-2', 'pw-secret-3', 'dXNlcjpwYXNz']) {
    assert.ok(!s.includes(leaked), `leaked ${leaked}`)
  }
  assert.equal(out.request?.cookies, undefined)
  assert.equal(out.request?.headers?.accept, 'text/html')
  assert.equal((out.request?.data as { name: string }).name, 'Widget')
})

test('strips Bearer token in a message', () => {
  const out = scrubEvent({ message: 'upstream said: Bearer eyJhbGciOi.payload.sig rejected' })
  assert.ok(out)
  assert.doesNotMatch(json(out), /eyJhbGciOi/)
})

test('strips nested token keys', () => {
  const out = scrubEvent({
    extra: { a: { b: [{ c: { accessToken: 'deep-1', refresh_token: 'deep-2', apiKey: 'deep-3', ok: 'fine' } }] } },
    contexts: { conn: { dsn: 'https://k@host/1', sessionId: 'deep-4' } },
    tags: { client_secret: 'deep-5', route: '/orders' },
  })
  assert.ok(out)
  const s = json(out)
  for (const n of ['deep-1', 'deep-2', 'deep-3', 'deep-4', 'deep-5', 'https://k@host/1']) assert.ok(!s.includes(n), n)
  assert.match(s, /\[Filtered\]/)
  assert.match(s, /fine/)
  assert.match(s, /\/orders/)
})

test('strips password in a postgres URL', () => {
  const out = scrubEvent({
    exception: { values: [{ type: 'Error', value: 'connect failed postgres://ims:s3cr3tpw@10.0.0.5:5432/ims?password=other1' }] },
  })
  assert.ok(out)
  const s = json(out)
  assert.ok(!s.includes('s3cr3tpw'))
  assert.ok(!s.includes('other1'))
  assert.match(s, /10\.0\.0\.5:5432\/ims/)
})

test('strips emails', () => {
  const out = scrubEvent({
    message: 'send to jane.doe+x@example.co.uk failed',
    user: { id: '7', email: 'jane@example.com', ip_address: '1.2.3.4', username: 'bob@example.com' },
  })
  assert.ok(out)
  const s = json(out)
  assert.ok(!s.includes('example.co.uk'))
  assert.ok(!s.includes('example.com'))
  assert.ok(!s.includes('1.2.3.4'))
  assert.equal(out.user?.email, undefined)
  assert.equal(out.user?.ip_address, undefined)
  assert.equal(out.user?.id, '7')
  assert.match(out.message ?? '', /\[email\]/)
})

test('keeps order ids and SKUs', () => {
  const msg = 'order 173814 SKU ABC-1'
  const out = scrubEvent({ message: msg, extra: { note: msg }, tags: { sku: 'ABC-1', order: '173814' } })
  assert.ok(out)
  assert.equal(out.message, msg)
  assert.equal((out.extra as { note: string }).note, msg)
  assert.deepEqual(out.tags, { sku: 'ABC-1', order: '173814' })
})

test('scrubs breadcrumbs', () => {
  const b: Breadcrumb = {
    category: 'fetch',
    message: 'GET https://api.example/x?api_key=bc-secret-1',
    data: { url: 'https://u:bc-pw@host/p', headers: { cookie: 'bc-cookie' }, status: 200 },
  }
  const out = scrubBreadcrumb(b)
  assert.ok(out)
  const s = json(out)
  for (const n of ['bc-secret-1', 'bc-pw', 'bc-cookie']) assert.ok(!s.includes(n), n)
  assert.equal((out.data as { status: number }).status, 200)
})

test('never throws on cyclic/odd input', () => {
  const cyc: Record<string, unknown> = { token: 'cyc-1', name: 'x' }
  cyc.self = cyc
  const evil = {
    get message(): string {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => scrubEvent({ extra: cyc } as Event))
  const out = scrubEvent({ extra: cyc } as Event)
  assert.ok(out)
  assert.ok(!json({ ...out, extra: undefined }).includes('cyc-1'))
  const bad = scrubEvent(evil as unknown as Event)
  assert.ok(bad)
  assert.equal(bad.message, '[scrub failed]')
  assert.doesNotThrow(() => scrubEvent(null as unknown as Event))
  assert.doesNotThrow(() => scrubBreadcrumb(undefined as unknown as Breadcrumb))
})

const CALLBACK = '/api/accounting/callback?code=SENTINELCODE123&state=SENTINELSTATE456'
const SENTINELS = ['SENTINELCODE123', 'SENTINELSTATE456', 'SENTINELTOKEN']

function assertNoSentinels(value: unknown): void {
  const s = json(value)
  for (const n of SENTINELS) assert.ok(!s.includes(n), `leaked ${n}`)
}

test('OAuth callback code/state do not survive an error event', () => {
  const out = scrubEvent({
    message: `GET ${CALLBACK} failed`,
    request: {
      url: `https://ims.example.test${CALLBACK}`,
      query_string: 'code=SENTINELCODE123&state=SENTINELSTATE456',
      headers: { 'x-upstream': 'Bearer SENTINELTOKEN' },
    },
    exception: { values: [{ type: 'Error', value: `callback https://ims.example.test${CALLBACK}` }] },
    breadcrumbs: [{ category: 'navigation', data: { from: '/', to: CALLBACK, url: `https://ims.example.test${CALLBACK}` } }],
    extra: { note: 'order 173814 SKU ABC-1' },
  })
  assert.ok(out)
  assertNoSentinels(out)
  assert.match(json(out), /\/api\/accounting\/callback/)
  assert.equal((out.extra as { note: string }).note, 'order 173814 SKU ABC-1')
})

test('OAuth callback code/state do not survive a streamed span', () => {
  const span = {
    trace_id: 't1',
    span_id: 's1',
    name: `GET ${CALLBACK}`,
    start_timestamp: 1,
    status: 'ok' as const,
    is_segment: true,
    attributes: {
      'url.full': { type: 'string', value: `https://ims.example.test${CALLBACK}` },
      'http.url': `https://ims.example.test${CALLBACK}`,
      'http.target': CALLBACK,
      'url.query': '?code=SENTINELCODE123&state=SENTINELSTATE456',
      'http.request.header.x-upstream': 'Bearer SENTINELTOKEN',
      'http.request.header.authorization': 'Bearer SENTINELTOKEN',
      'user.email': 'a@b.example',
      'client.address': '9.9.9.9',
      'sentry.note': 'order 173814 SKU ABC-1',
    },
  }
  const out = scrubSpan(span)
  assertNoSentinels(out)
  assert.ok(!json(out).includes('a@b.example'))
  assert.ok(!json(out).includes('9.9.9.9'))
  assert.match(out.name, /\/api\/accounting\/callback/)
  assert.equal(out.attributes['sentry.note'], 'order 173814 SKU ABC-1')
  assert.equal(out.span_id, 's1')
})

test('OAuth callback code/state do not survive a transaction or breadcrumb', () => {
  const tx = scrubEvent({ type: 'transaction', transaction: CALLBACK, request: { url: `https://x.test${CALLBACK}` } } as Event)
  assertNoSentinels(tx)
  const bc = scrubBreadcrumb({ category: 'fetch', data: { url: `https://x.test${CALLBACK}`, headers: { a: 'Bearer SENTINELTOKEN' } } })
  assertNoSentinels(bc)
})

test('scrubSpan never throws and does not leak on odd input', () => {
  const cyc: Record<string, unknown> = { name: 'x', attributes: {} }
  cyc.self = cyc
  assert.doesNotThrow(() => scrubSpan(cyc))
  const evil = {
    span_id: 's2',
    get attributes(): never {
      throw new Error('boom')
    },
  }
  const out = scrubSpan(evil) as unknown as { name: string; span_id: string }
  assert.equal(out.name, '[scrub failed]')
  assert.equal(out.span_id, 's2')
  assert.doesNotThrow(() => scrubSpan(null as unknown as object))
})

test('plain text containing a question mark is left alone', () => {
  const msg = 'why did order 173814 SKU ABC-1 fail? see /orders/173814'
  assert.equal(scrubEvent({ message: msg })?.message, msg)
})

const SIG_HEADERS = {
  'x-mintsoft-signature': 'SIGSENTINEL1',
  'x-oti-signature': 'SIGSENTINEL2',
  'x-wc-webhook-signature': 'SIGSENTINEL3',
  'X-Hub-Signature-256': 'SIGSENTINEL4',
  'x-shopify-hmac-sha256': 'SIGSENTINEL5',
  'x-request-nonce': 'SIGSENTINEL6',
  'x-sig': 'SIGSENTINEL7',
  'user-agent': 'curl/8',
}

function assertNoSigSentinels(value: unknown): void {
  const s = json(value)
  for (let i = 1; i <= 7; i++) assert.ok(!s.includes(`SIGSENTINEL${i}`), `leaked SIGSENTINEL${i}`)
}

test('webhook signature headers do not survive an event, a streamed span or a breadcrumb', () => {
  const ev = scrubEvent({ request: { headers: { ...SIG_HEADERS } }, extra: { headers: { ...SIG_HEADERS } } })
  assert.ok(ev)
  assertNoSigSentinels(ev)
  assert.equal(ev.request?.headers?.['user-agent'], 'curl/8')

  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(SIG_HEADERS)) attrs[`http.request.header.${k}`] = v
  const span = scrubSpan({ name: 'POST /api/webhooks', attributes: { ...attrs, 'http.request.header.user-agent': 'curl/8' } })
  assertNoSigSentinels(span)
  assert.equal(span.attributes['http.request.header.user-agent'], 'curl/8')

  const bc = scrubBreadcrumb({ category: 'http', data: { request_headers: { ...SIG_HEADERS } } })
  assertNoSigSentinels(bc)
})

test('signature key rule has no false positives on ordinary fields', () => {
  const out = scrubEvent({ extra: { sku: 'ABC-1', designation: 'x', assignedTo: 'y', significance: 'z', orderId: '173814' } })
  assert.deepEqual(out?.extra, { sku: 'ABC-1', designation: 'x', assignedTo: 'y', significance: 'z', orderId: '173814' })
})

test('URL fragments do not survive any carrier; path is kept; "#" in prose is untouched', () => {
  const frag1 = '/api/accounting/callback#code=SENTINELFRAG1&state=SENTINELFRAG2'
  const frag2 = '/api/accounting/callback?x=1#access_token=SENTINELFRAG3'
  const all = [frag1, frag2, `https://ims.example.test${frag1}`, `https://ims.example.test${frag2}`]
  const noFrag = (v: unknown) => {
    const s = json(v)
    for (const n of ['SENTINELFRAG1', 'SENTINELFRAG2', 'SENTINELFRAG3']) assert.ok(!s.includes(n), `leaked ${n}`)
    assert.match(s, /\/api\/accounting\/callback/)
  }
  for (const u of all) {
    noFrag(scrubEvent({ message: `GET ${u} failed`, request: { url: u }, transaction: u }))
    noFrag(scrubBreadcrumb({ category: 'navigation', message: u, data: { to: u, url: u } }))
    noFrag(
      scrubSpan({
        name: `GET ${u}`,
        attributes: { 'url.full': u, 'http.url': u, 'http.target': u, 'url.fragment': 'code=SENTINELFRAG1&state=SENTINELFRAG2' },
      }),
    )
  }
  assert.equal(scrubEvent({ message: 'order #173814 SKU ABC-1' })?.message, 'order #173814 SKU ABC-1')
  assert.equal(scrubEvent({ message: 'see /orders/173814 and #5' })?.message, 'see /orders/173814 and #5')
})

test('AI / MCP payload attributes do not survive a streamed span', () => {
  const out = scrubSpan({
    name: 'chat claude',
    attributes: {
      'gen_ai.request.messages': '[{"role":"user","content":"Describe SENTINELPROMPT widget"}]',
      'gen_ai.response.text': 'SENTINELPROMPT is a fine widget',
      'gen_ai.system_instructions': 'SENTINELPROMPT system',
      'gen_ai.request.model': 'some-model',
      'ai.prompt': 'SENTINELPROMPT',
      'mcp.tool.result.content': 'SENTINELPROMPT',
      'sentry.note': 'order 173814 SKU ABC-1',
    },
  })
  assert.ok(!json(out).includes('SENTINELPROMPT'))
  assert.equal(out.attributes['gen_ai.request.model'], 'some-model')
  assert.equal(out.attributes['sentry.note'], 'order 173814 SKU ABC-1')
})
