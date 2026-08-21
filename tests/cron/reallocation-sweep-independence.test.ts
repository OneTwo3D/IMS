import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-z82a, Codex review r5, FINDING 3.
 *
 * The direct-create marker sweep is the ONLY mechanism that bounds the activity-log retention
 * exemption those markers hold. It used to be sequenced behind a bare `await` on the allocation
 * sweep, so a throw there skipped it entirely — the drain stopped running exactly when the system
 * was unhealthy, which is when markers accumulate fastest and when the exemption is least
 * affordable.
 *
 * This is the behavioural proof, not a source assertion: the first pass throws, and the second
 * one must still run and still be reported.
 */

const calls: string[] = []
let allocationThrows = false
let markerThrows = false
/** The budget the route handed the marker sweep, so "bounded wall time" is observable. */
let markerOptions: { budgetMs?: number } | undefined

mock.module('@/lib/cron-auth', {
  namedExports: { verifyCron: async () => null },
})
mock.module('@/lib/cron-rate-limit', {
  namedExports: {
    CRON_RATE_LIMIT_FIFTEEN_MINUTE_MAX: 10,
    enforceCronRateLimit: async () => null,
  },
})
mock.module('@/lib/maintenance-mode', {
  namedExports: { getMaintenanceModeResponse: async () => null },
})
mock.module('@/lib/fulfillment/reallocation-sweep', {
  namedExports: {
    sweepUnallocatedProcessingOrders: async () => {
      calls.push('allocation')
      if (allocationThrows) throw new Error('allocation pass exploded')
      return { scanned: 3, needing: 0, allocated: 0, skipped: 0, errors: 0, hasRemainder: false, nextCursor: '', cursorPersisted: true }
    },
  },
})
mock.module('@/lib/fulfillment/pre-fulfilment-reallocation', {
  namedExports: {
    sweepUnresolvedDirectCreateMarkers: async (options?: { budgetMs?: number }) => {
      calls.push('markers')
      markerOptions = options
      if (markerThrows) throw new Error('marker pass exploded')
      return { scanned: 2, recorded: 1, resolved: 2, retracted: 0, errors: 0, budgetExhausted: false }
    },
  },
})

function cronRequest(): Request {
  return new Request('https://ims.example.com/api/cron/reallocation-sweep', {
    headers: new Headers({ host: 'ims.example.com' }),
  })
}

async function runRoute(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/cron/reallocation-sweep/route')
  const response = await GET(cronRequest())
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function reset() {
  calls.length = 0
  allocationThrows = false
  markerThrows = false
  markerOptions = undefined
}

test('a failing allocation pass does not skip the marker sweep (o3d-z82a)', async () => {
  reset()
  allocationThrows = true

  const { status, body } = await runRoute()

  assert.deepEqual(calls, ['allocation', 'markers'], 'the marker sweep must run anyway')
  assert.deepEqual(body.directCreateMarkers, {
    scanned: 2, recorded: 1, resolved: 2, retracted: 0, errors: 0, budgetExhausted: false,
  }, 'and its counts must still be reported')
  // The failure is still surfaced — a throw used to be a 500, and quietly turning that into a 200
  // would trade one regression for another.
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.match(String((body.failures as Record<string, string>).reallocationSweep), /allocation pass exploded/)
})

test('a failing marker sweep does not discard the allocation pass\'s result (o3d-z82a)', async () => {
  // The independence has to hold in both directions, or the next change reintroduces it the other
  // way round: work that was actually done must not vanish because the pass after it failed.
  reset()
  markerThrows = true

  const { status, body } = await runRoute()

  assert.deepEqual(calls, ['allocation', 'markers'])
  assert.equal(body.scanned, 3, 'the allocation pass\'s result is still reported')
  assert.equal(body.directCreateMarkers, null)
  assert.equal(status, 500)
  assert.match(String((body.failures as Record<string, string>).directCreateMarkerSweep), /marker pass exploded/)
})

test('both passes succeeding is a plain 200 with both results (o3d-z82a)', async () => {
  reset()

  const { status, body } = await runRoute()

  assert.equal(status, 200)
  assert.equal(body.ok, undefined, 'no failure key when nothing failed')
  assert.equal(body.failures, undefined)
  assert.equal(body.scanned, 3)
  assert.equal((body.directCreateMarkers as Record<string, unknown>).resolved, 2)
})

test('the marker sweep is given only the wall-clock budget the tick has left (o3d-z82a)', async () => {
  // FINDING 4 at the endpoint: the allocation pass cannot be interrupted safely, so its time is
  // subtracted from the marker sweep's budget rather than added to the tick's total.
  reset()

  await runRoute()

  assert.ok(markerOptions, 'the route must pass options')
  assert.equal(typeof markerOptions?.budgetMs, 'number')
  assert.ok((markerOptions?.budgetMs ?? -1) >= 0, 'never negative — a zero budget still resolves one marker')
  assert.ok((markerOptions?.budgetMs ?? 0) <= 300_000, 'and never more than the tick\'s whole budget')
})
