import { grantXeroWrites, restoreOutboundGrants } from '../helpers/outbound-grants'
import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

/**
 * #1132 R2-LOW-7 / R2-MED-1 — THE BOUNDED XERO CALL, ON THE REAL TRANSPORT WITH A STUB FETCH.
 *
 * The refund delete's void worker calls Xero while it holds database locks inside a transaction with a deadline. A bounded call must therefore:
 *   - never sleep (no minute-budget wait, no Retry-After) and make ONE attempt, a Xero 429 handed straight back;
 *   - abort its one attempt at its own timeout, and never later than the caller's deadline; an abort after the request left is NOT a not-sent
 *     refusal (it may have arrived), so it throws untagged and the void reports the outcome as unknown;
 *   - refuse to send at all (tagged `bounded-deadline`) when, at the last statement before the socket, too little of the deadline is left;
 *   - use the auth its caller resolved before taking the locks, never resolving (or refreshing) a token itself.
 *
 * Only the edges are doubled: the token resolver (counted), the posting intent, the egress authorisation and `connectorFetch`. Nothing leaves
 * the process.
 */

let resolverCalls = 0
let egressDelayMs = 0
type Answer = { status: number; body?: unknown; retryAfter?: string; hang?: boolean; throwAfterSend?: Error }
let answers: Answer[] = []
const wire: Array<{ url: string; method: string | undefined }> = []

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => { resolverCalls++; return { accessToken: 'resolved', tenantId: 'tenant-resolved', connectionGeneration: null } },
    getStoredTenantBlockReason: async () => null,
  },
})
mock.module('@/lib/connectors/accounting-posting-intent', { namedExports: { accountingPostingIntentRefusal: () => null } })
mock.module('@/lib/connectors/accounting-egress-authorization', {
  namedExports: {
    accountingEgressRefusal: async () => {
      if (egressDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, egressDelayMs))
      return null
    },
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init: RequestInit) => {
      wire.push({ url, method: init.method })
      const answer = answers.shift() ?? { status: 200, body: {} }
      if (answer.hang) {
        // The request has left; the reply never comes. Only the call's own abort ends it.
        await new Promise((_resolve, reject) => {
          const signal = init.signal
          if (!signal) return
          if (signal.aborted) reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (answer.throwAfterSend) throw answer.throwAfterSend
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        headers: { get: (name: string) => (name === 'Retry-After' ? answer.retryAfter ?? null : null) },
        json: async () => answer.body,
        text: async () => JSON.stringify(answer.body ?? {}),
      } as unknown as Response
    },
  },
})

after(() => restoreOutboundGrants())

let tenantSeq = 0
function freshAuth() {
  // A fresh tenant per test: the rate buckets are per tenant and process-wide.
  const tenantId = `bounded-tenant-${++tenantSeq}-${Math.random()}`
  grantXeroWrites(tenantId)
  return { accessToken: 'pre-resolved', tenantId, connectionGeneration: null }
}
function reset() {
  answers = []
  wire.length = 0
  resolverCalls = 0
  egressDelayMs = 0
}

test('a bounded call uses the auth its caller resolved: the token resolver is never asked', async () => {
  reset()
  const { xeroGet } = await import('@/lib/connectors/xero/api')
  answers = [{ status: 200, body: { CreditNotes: [] } }]
  const res = await xeroGet('CreditNotes/x', { bounded: { timeoutMs: 1000, auth: freshAuth() } })
  assert.equal(res.ok, true)
  assert.equal(resolverCalls, 0, 'no token resolution (or refresh) inside the bound')
  // Without a pre-resolved auth the call resolves its own, as before.
  answers = [{ status: 200, body: {} }]
  await xeroGet('CreditNotes/x', { bounded: { timeoutMs: 1000 } })
  assert.equal(resolverCalls, 1)
})

test('a Xero 429 on a bounded call is ONE attempt and no sleep, handed straight back (an unbounded call would sleep out Retry-After and retry)', async () => {
  reset()
  const { xeroPost } = await import('@/lib/connectors/xero/api')
  answers = [{ status: 429, retryAfter: '30', body: { Message: 'rate limited' } }, { status: 200, body: {} }]
  const started = Date.now()
  const res = await xeroPost('CreditNotes/x', { CreditNotes: [] }, { idempotencyKey: 'k', bounded: { timeoutMs: 5000, auth: freshAuth() } })
  assert.equal(res.status, 429)
  assert.equal(wire.length, 1, 'a single attempt')
  assert.ok(Date.now() - started < 1000, 'no Retry-After sleep')
  assert.equal(res.notSent, undefined, 'a 429 Xero sent back is an answer, not a pre-egress refusal')
})

test('the minute budget spent: a bounded call refuses at once, not sent, worded for a call that never waits (R2-LOW-8)', async () => {
  reset()
  const { xeroGet } = await import('@/lib/connectors/xero/api')
  const auth = freshAuth()
  // Spend this tenant's minute budget (55 calls in the rolling minute).
  for (let i = 0; i < 55; i++) {
    answers.push({ status: 200, body: {} })
    await xeroGet('Organisation', { bounded: { timeoutMs: 1000, auth } })
  }
  wire.length = 0
  const started = Date.now()
  const res = await xeroGet('CreditNotes/x', { bounded: { timeoutMs: 1000, auth } })
  assert.ok(Date.now() - started < 1000, 'no minute-budget wait')
  assert.equal(res.status, 429)
  assert.equal(res.notSent, 'rate-budget-refused')
  assert.equal(wire.length, 0, 'nothing reached the wire')
  assert.doesNotMatch(res.error ?? '', /360s|Idempotency-Key for|already spent on this call/, 'not the six-minute-window wording of an unbounded call')
  assert.match(res.error ?? '', /does not wait/)
})

test('THE ABORT: an attempt that hangs is aborted at its own timeout; after the request left that is NOT a not-sent refusal (it throws untagged)', async () => {
  reset()
  const { xeroPost } = await import('@/lib/connectors/xero/api')
  answers = [{ status: 0, hang: true }]
  const started = Date.now()
  await assert.rejects(
    xeroPost('CreditNotes/x', { CreditNotes: [] }, { idempotencyKey: 'k', bounded: { timeoutMs: 80, auth: freshAuth() } }),
    (error: unknown) => error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`),
  )
  const took = Date.now() - started
  assert.ok(took >= 60 && took < 2000, `aborted at its own timeout (${took} ms)`)
  assert.equal(wire.length, 1)
})

test('THE ABORT IS CUT TO THE CALLER\'S DEADLINE: a 15 s call with 100 ms of the deadline left is aborted at the deadline', async () => {
  reset()
  const { xeroPost, boundedAbortAfterMs } = await import('@/lib/connectors/xero/api')
  assert.equal(boundedAbortAfterMs({ timeoutMs: 15_000, deadlineAt: 1_000_500 }, 1_000_000), 500)
  assert.equal(boundedAbortAfterMs({ timeoutMs: 15_000 }, 1_000_000), 15_000)
  assert.equal(boundedAbortAfterMs({ timeoutMs: 15_000, deadlineAt: 900_000 }, 1_000_000), 1, 'never zero or negative')
  answers = [{ status: 0, hang: true }]
  const started = Date.now()
  // The deadline leaves room to send (above the minimum window) but far less than the call's own timeout.
  const { XERO_BOUNDED_MIN_SEND_WINDOW_MS } = await import('@/lib/connectors/xero/api')
  const deadlineAt = Date.now() + XERO_BOUNDED_MIN_SEND_WINDOW_MS + 300
  await assert.rejects(xeroPost('CreditNotes/x', {}, { idempotencyKey: 'k', bounded: { timeoutMs: 15_000, deadlineAt, auth: freshAuth() } }))
  assert.ok(Date.now() <= deadlineAt + 200, `aborted by the deadline, not the 15 s timeout (${Date.now() - started} ms)`)
})

test('THE DEADLINE RE-READ AT THE SOCKET: time spent before the send (a slow egress authorisation) leaves too little, so it is NOT SENT (bounded-deadline)', async () => {
  reset()
  const { xeroPost, XERO_BOUNDED_MIN_SEND_WINDOW_MS } = await import('@/lib/connectors/xero/api')
  // Enough of the deadline when the call is made; the egress authorisation (a database call) then eats it.
  egressDelayMs = 300
  const deadlineAt = Date.now() + XERO_BOUNDED_MIN_SEND_WINDOW_MS + 150
  const res = await xeroPost('CreditNotes/x', {}, { idempotencyKey: 'k', bounded: { timeoutMs: 15_000, deadlineAt, auth: freshAuth() } })
  assert.equal(res.ok, false)
  assert.equal(res.notSent, 'bounded-deadline')
  assert.equal(wire.length, 0, 'nothing reached the wire')
  // A deadline already past: the same.
  egressDelayMs = 0
  const past = await xeroPost('CreditNotes/x', {}, { idempotencyKey: 'k', bounded: { timeoutMs: 15_000, deadlineAt: Date.now() - 1, auth: freshAuth() } })
  assert.equal(past.notSent, 'bounded-deadline')
  assert.equal(wire.length, 0)
  // With room, the same call is sent.
  const sent = await xeroPost('CreditNotes/x', {}, { idempotencyKey: 'k', bounded: { timeoutMs: 15_000, deadlineAt: Date.now() + 30_000, auth: freshAuth() } })
  assert.equal(sent.ok, true)
  assert.equal(wire.length, 1)
})

test('voidCreditNote over the real transport: a 429 or a deadline refusal on the void is notSent; an abort after the send is unknown (not notSent)', async () => {
  reset()
  const { voidCreditNote } = await import('@/lib/connectors/xero/credit-notes')
  const ID = 'a1b2c3d4-0000-4000-8000-000000000001'
  const standing = { status: 200, body: { CreditNotes: [{ CreditNoteID: ID, Type: 'ACCRECCREDIT', Status: 'AUTHORISED', Allocations: [], Payments: [] }] } }
  const auth = freshAuth()

  answers = [standing, { status: 429, retryAfter: '5' }]
  const limited = await voidCreditNote({ creditNoteId: ID }, { idempotencyKey: 'k', bounded: { timeoutMs: 5000, auth } })
  assert.equal(limited.success, false)
  assert.equal(limited.notSent, true, 'Xero rejected the void: not applied')
  assert.equal(wire.length, 2)

  answers = [standing, { status: 0, hang: true }]
  const lost = await voidCreditNote({ creditNoteId: ID }, { idempotencyKey: 'k', bounded: { timeoutMs: 80, auth } })
  assert.equal(lost.success, false)
  assert.equal(lost.notSent, undefined, 'an abort after the request left may have voided it')
  assert.match(lost.error ?? '', /not known/)
})
