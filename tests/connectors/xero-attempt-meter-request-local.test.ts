import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-11rf r3 (Codex r2, MEDIUM) — WHAT A "PER-POLL" XERO REQUEST COUNT ACTUALLY COUNTS.
 *
 * THE DEFECT THIS EXISTS FOR, AND IT WAS A DEFECT IN A FIX. o3d-pzu0 r2 corrected an
 * under-report — the withheld-reversal recheck's own traffic was missing from the poll's cost — by
 * measuring the DELTA of `xeroHttpAttemptCount()` across the recheck. That counter is PROCESS-WIDE:
 * it counts every attempt this process makes against Xero, across all tenants and all jobs. So the
 * correction swapped a number that EXCLUDED the recheck's calls for one that INCLUDED everybody
 * else's. The comment it shipped with claimed the payment-write lock made the interval exclusive;
 * that lock excludes the payment RECONCILE job and nothing else, leaving main sync, the daily batch,
 * a manual sync and the outbox free to run during the await and be charged to the poll.
 *
 * WHY A DOUBLE CANNOT SHOW THIS. The interleaving is the subject. It happens because Node yields at
 * an `await` inside the transport's retry loop, so it can only be demonstrated against the REAL loop
 * with a real concurrent caller sitting in it. The transport here is therefore real; only its edges
 * are doubled — auth, the two authorisations, and `connectorFetch` — exactly as
 * tests/accounting/xero-transport-not-sent-proof.test.ts does.
 *
 * AND IT IS PINNED FROM BOTH SIDES, which is what stops it passing vacuously. Asserting only that
 * the meter reads 1 would pass against a meter that never counts anything at all. Each test also
 * asserts what the PROCESS-WIDE delta reads over the same interval, so the test states the number
 * the old measure would have produced and the number the new one does. If the interleaving ever
 * stopped happening, the process-wide assertion fails and the test says so instead of quietly
 * proving nothing.
 */

let auth: { accessToken: string; tenantId: string } | null = { accessToken: 'tok', tenantId: 'tenant-1' }
type Answer = { status: number; body?: unknown; throws?: Error; retryAfter?: string }
let answers = new Map<string, Answer[]>()
const wireCalls: string[] = []
/** A path whose fetch parks until `release()` is called — the await another job gets to run inside. */
let parkedPath: string | null = null
let releaseParked: (() => void) | null = null

function answerFor(url: string): Answer {
  for (const [needle, queue] of answers) {
    if (url.includes(needle)) {
      const next = queue.shift()
      if (next) return next
    }
  }
  return { status: 200, body: { Invoices: [] } }
}

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => auth,
    getStoredTenantBlockReason: async () => null,
  },
})

mock.module('@/lib/connectors/accounting-posting-intent', {
  namedExports: { accountingPostingIntentRefusal: () => null },
})

mock.module('@/lib/connectors/accounting-egress-authorization', {
  namedExports: { accountingEgressRefusal: async () => null },
})

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      wireCalls.push(url)
      if (parkedPath && url.includes(parkedPath)) {
        parkedPath = null
        await new Promise<void>((resolve) => { releaseParked = resolve })
      }
      const answer = answerFor(url)
      if (answer.throws) throw answer.throws
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

type ApiModule = typeof import('../../lib/connectors/xero/api.ts')

async function api(): Promise<ApiModule> {
  return await import('@/lib/connectors/xero/api')
}

function reset() {
  wireCalls.length = 0
  answers = new Map()
  parkedPath = null
  releaseParked = null
  // A fresh tenant per test: the rate buckets are per-tenant and process-wide, so one test's spend
  // must not decide another's budget verdict.
  auth = { accessToken: 'tok', tenantId: `tenant-${Math.random()}` }
}

/** Yield until the parked request has actually reached the socket and blocked there. */
async function untilParked() {
  for (let i = 0; i < 50 && !releaseParked; i += 1) await new Promise((r) => setImmediate(r))
  assert.ok(releaseParked, 'the metered request reached the transport and parked, so another job can interleave')
}

test('a concurrent unrelated Xero caller is NOT charged to the metered request (o3d-11rf r3)', async () => {
  reset()
  const { xeroGet, createXeroAttemptMeter, xeroHttpAttemptCount } = await api()

  const meter = createXeroAttemptMeter()
  const globalBefore = xeroHttpAttemptCount()

  // The metered request goes out and parks inside the transport, exactly where a real one waits on
  // its socket.
  parkedPath = 'Invoices'
  const metered = xeroGet('Invoices?where=x', { attemptMeter: meter })
  await untilParked()

  // ANOTHER JOB — main sync, the daily batch, a manual sync — runs during that await. Nothing
  // excludes it: the payment-write lock covers only the payment reconcile.
  await xeroGet('Contacts')
  await xeroGet('Items')
  await xeroGet('BankTransactions')

  releaseParked?.()
  await metered

  assert.equal(meter.attempts, 1, 'THE POINT: the meter counted only the request it was handed to')
  assert.equal(
    xeroHttpAttemptCount() - globalBefore, 4,
    'and the PROCESS-WIDE delta over the same interval is 4 — the number the old measure reported '
    + 'for a single request, and the reason it was not a measurement',
  )
})

test('the meter still counts real ATTEMPTS, not invocations, when one call retries (o3d-11rf r3)', async () => {
  reset()
  const { xeroGet, createXeroAttemptMeter } = await api()
  // Two 429s then success: ONE xeroGet invocation, THREE tenant API calls. This is the property the
  // process-wide counter was chosen for in the first place (o3d-8f9 r3) and it must survive the move
  // to a request-local one — a meter that counted invocations would report 1 and understate the
  // tenant's real draw by 3x on exactly the calls that cost the most.
  answers.set('Invoices', [
    { status: 429, retryAfter: '0' },
    { status: 429, retryAfter: '0' },
    { status: 200, body: { Invoices: [] } },
  ])

  const meter = createXeroAttemptMeter()
  const response = await xeroGet('Invoices?where=y', { attemptMeter: meter })

  assert.equal(response.ok, true, 'the call succeeded on its third attempt')
  assert.equal(meter.attempts, 3, 'and all three attempts are counted, not the one invocation')
})

test('the meter survives a request that throws mid-flight (o3d-11rf r3)', async () => {
  reset()
  const { xeroGet, createXeroAttemptMeter } = await api()
  // A reset mid-write, a timeout, a DNS failure. The attempt was still made and still cost the
  // tenant a call. The count survives because the CALLER owns the meter — a count carried back on a
  // response would be lost along with the response, and the spend would go unreported for precisely
  // the runs that went worst.
  answers.set('Invoices', [{ status: 0, throws: new Error('socket hang up') }])

  const meter = createXeroAttemptMeter()
  await assert.rejects(() => xeroGet('Invoices?where=z', { attemptMeter: meter }), /socket hang up/)

  assert.equal(meter.attempts, 1, 'the attempt that threw is still counted')
})

test('a request given no meter still moves the process-wide counter (o3d-11rf r3)', async () => {
  reset()
  const { xeroGet, xeroHttpAttemptCount } = await api()
  // The meter ADDS a population; it does not replace the total. `xeroHttpAttemptCount` remains the
  // honest answer to "what has this process spent", which the journal poster's dispatch honesty and
  // the tenant-wide view both still read.
  const before = xeroHttpAttemptCount()
  await xeroGet('Contacts')
  assert.equal(xeroHttpAttemptCount() - before, 1, 'an unmetered request is still counted process-wide')
})
