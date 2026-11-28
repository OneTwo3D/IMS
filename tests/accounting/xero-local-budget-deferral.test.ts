import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  LOCAL_BUDGET_DEFER_MARGIN_MS,
  LOCAL_BUDGET_MIN_DEFER_MS,
  describeLocalBudgetRefusal,
  getRateLimitBackoffMs,
  isRateLimitError,
  localBudgetDeferMs,
  parseLocalBudgetRefusal,
} from '@/lib/connectors/xero/deferral'

/**
 * IMS'S OWN XERO CALL BUDGET (950 per rolling 24h, 55 per minute, per tenant per process) IS A DEFERRAL, NOT A FAILURE.
 *
 * The refusal used to read "Xero day budget exhausted ..." which `isRateLimitError` did not match, so a sales invoice, credit note, bill or payment
 * spent a retry per tick and went FAILED after MAX_RETRIES without ever having been sent. These tests drive the REAL transport (real `xeroPost`, real
 * limiter) over a mocked `connectorFetch`, with the clock mocked: nothing touches the network.
 */

const DAY_MS = 86_400_000
let tenant = 'tenant-unset'
let sent: number = 0
let handler: (url: string, init: RequestInit) => Promise<Response> = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => ({ accessToken: 'test-token', tenantId: tenant }),
    getStoredTenantBlockReason: async () => null,
    getGrantedScopes: async () => [],
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: { connectorFetch: (url: string, init: RequestInit) => { sent += 1; return handler(url, init) } },
})
mock.module('@/lib/connectors/accounting-posting-intent', { namedExports: { accountingPostingIntentRefusal: () => null } })
mock.module('@/lib/connectors/accounting-egress-authorization', { namedExports: { accountingEgressRefusal: async () => null } })
mock.module('@/lib/security/outbound-write-grant', {
  namedExports: { outboundWriteRefusal: () => null, OutboundWriteHeldError: class extends Error {} },
})
mock.module('@/lib/connectors/xero/day-limit-observation', { namedExports: { persistDayLimitObservation: async () => undefined } })

async function fillDay(api: typeof import('@/lib/connectors/xero/api'), calls: number) {
  for (let i = 0; i < calls; i++) {
    const res = await api.xeroGet('Organisation')
    assert.equal(res.ok, true, `fill call ${i} was sent`)
    // Spread over time so the MINUTE cap (55) does not interfere: one call every 2s.
    mock.timers.tick(2_000)
  }
}

test('the tag round-trips, is the only thing recognised, and the delay is the wait plus a margin with a floor', () => {
  const text = `anything at all ${describeLocalBudgetRefusal('day', 3_600_000)}`
  assert.deepEqual(parseLocalBudgetRefusal(text), { kind: 'day', waitMs: 3_600_000 })
  assert.equal(isRateLimitError(text), true)
  assert.equal(localBudgetDeferMs(text), 3_600_000 + LOCAL_BUDGET_DEFER_MARGIN_MS)
  assert.equal(getRateLimitBackoffMs(4, text), 3_600_000 + LOCAL_BUDGET_DEFER_MARGIN_MS, 'not exponential: the limiter knows when a slot frees')
  assert.equal(localBudgetDeferMs(describeLocalBudgetRefusal('minute', 1_000)), LOCAL_BUDGET_MIN_DEFER_MS, 'floor: never a hot loop')
  // The old prose alone is NOT what is recognised.
  assert.equal(isRateLimitError('Xero day budget exhausted for this tenant: 950 calls used'), false)
  assert.equal(parseLocalBudgetRefusal('[ims-xero-local-budget kind=week wait=1ms]'), null)
})

test('Xero\'s own 429 and ordinary failures are unchanged', () => {
  assert.equal(isRateLimitError('Rate limited after retries; retry after 90000ms'), true)
  assert.equal(getRateLimitBackoffMs(0, 'Rate limited; retry after 120000ms'), 120_000)
  assert.equal(getRateLimitBackoffMs(2, 'status 429'), 240_000)
  assert.equal(isRateLimitError('Failed to create invoice'), false)
  assert.equal(localBudgetDeferMs('Rate limited; retry after 120000ms'), null)
})

test('day cap: invoice, credit note, bill and payment posts are refused NOT SENT, defer without a retry, and are offered again after the window', async (t) => {
  tenant = 'tenant-day-cap'
  sent = 0
  const api = await import('@/lib/connectors/xero/api')
  mock.timers.enable({ apis: ['Date'] })
  t.after(() => mock.timers.reset())

  await fillDay(api, 950)
  assert.equal(sent, 950)
  const filledAt = Date.now()

  const documents: Array<[string, string, unknown]> = [
    ['sales invoice', 'Invoices', { Invoices: [{ Type: 'ACCREC' }] }],
    ['credit note', 'CreditNotes', { CreditNotes: [{ Type: 'ACCRECCREDIT' }] }],
    ['bill', 'Invoices', { Invoices: [{ Type: 'ACCPAY' }] }],
    ['payment', 'Payments', { Payments: [{ Amount: 1 }] }],
  ]
  for (const [label, endpoint, body] of documents) {
    const before: number = sent
    const res = await api.xeroPost(endpoint, body, { idempotencyKey: `key-${label}` })
    assert.equal(res.ok, false, label)
    assert.equal(sent, before, `${label}: nothing left the process`)
    assert.equal(res.notSent, 'rate-budget-refused', `${label}: typed as a provable pre-egress budget refusal`)
    const message = res.error ?? ''
    // The processor's decision, from the real text: defer, do not spend, wait for calls to fall out of the window.
    assert.equal(isRateLimitError(message), true, `${label}: deferred, so no retry is spent and the row is never FAILED`)
    const refusal = parseLocalBudgetRefusal(message)
    assert.equal(refusal?.kind, 'day')
    const delay = getRateLimitBackoffMs(4, message)
    const oldestFallsOutIn = DAY_MS - (filledAt - (filledAt - 949 * 2_000 - 2_000))
    assert.ok(Math.abs(delay - (oldestFallsOutIn + LOCAL_BUDGET_DEFER_MARGIN_MS)) < 5_000, `${label}: waits until the oldest call leaves the window (${delay} vs ${oldestFallsOutIn})`)
  }

  // Offered again after the window: once the clock passes the computed delay the same post is SENT.
  const res = await api.xeroPost('Invoices', { Invoices: [{ Type: 'ACCREC' }] }, { idempotencyKey: 'key-after' })
  const delay = getRateLimitBackoffMs(0, res.error ?? '')
  mock.timers.tick(delay)
  const before: number = sent
  const retried = await api.xeroPost('Invoices', { Invoices: [{ Type: 'ACCREC' }] }, { idempotencyKey: 'key-after' })
  assert.equal(retried.ok, true, 'after the computed wait a slot has freed and the post goes out')
  assert.equal(sent, before + 1)
})

test('minute cap: a bounded call is refused NOT SENT with the same typed token and defers about a minute; the refusal keeps its wording', async (t) => {
  tenant = 'tenant-minute-cap'
  sent = 0
  const api = await import('@/lib/connectors/xero/api')
  mock.timers.enable({ apis: ['Date'] })
  t.after(() => mock.timers.reset())

  for (let i = 0; i < 55; i++) assert.equal((await api.xeroGet('Organisation')).ok, true)
  const before: number = sent
  const res = await api.xeroPost('Invoices', { Invoices: [] }, { idempotencyKey: 'k', bounded: { timeoutMs: 5_000, deadlineAt: Date.now() + 60_000 } })
  assert.equal(res.ok, false)
  assert.equal(sent, before)
  assert.equal(res.notSent, 'rate-budget-refused')
  const message = res.error ?? ''
  assert.equal(isRateLimitError(message), true)
  assert.equal(parseLocalBudgetRefusal(message)?.kind, 'minute')
  const delay = getRateLimitBackoffMs(0, message)
  assert.ok(delay >= 30_000 && delay <= 62_000, `about the next minute, got ${delay}`)
  assert.match(message, /Not sent; the work is retried from the queue/, 'the bounded refusal keeps its wording')
})

test('Xero\'s own 429 reply is still not tagged as a local refusal and not typed as not-sent', async (t) => {
  tenant = 'tenant-own-429'
  const api = await import('@/lib/connectors/xero/api')
  mock.timers.enable({ apis: ['Date'] })
  t.after(() => mock.timers.reset())
  handler = async () => new Response('Rate limit exceeded', { status: 429, headers: { 'Retry-After': '1000000' } })
  t.after(() => { handler = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) })
  const res = await api.xeroGet('Organisation')
  assert.equal(res.status, 429)
  assert.equal(parseLocalBudgetRefusal(res.error ?? ''), null)
  assert.equal(isRateLimitError(res.error ?? ''), true, 'still deferred by the existing rate-limit rule')
})
