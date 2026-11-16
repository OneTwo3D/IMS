import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SYSTEMIC_PARAMS,
  EMPTY_SYSTEMIC_STATE,
  SYSTEMIC_ENDPOINT_FAILURE_PASSES,
  SYSTEMIC_FAILURE_MIN_RECORDS,
  SYSTEMIC_FAILURE_RATIO,
  SYSTEMIC_MAX_CONSECUTIVE,
  decideSystemicFailure,
  describeSystemicIncident,
  isMassFailure,
  parseSystemicState,
  runSystemicPass,
  type SystemicFailureStore,
  type SystemicIncident,
  type SystemicState,
} from '../lib/domain/wms/systemic-failure.ts'

/**
 * The systemic-failure circuit breaker: the plugin's rule, ported parameter for parameter. Pure decision first, then the lifecycle
 * (counter, ONE incident, resolve) over an in-memory store. Nothing here touches a database or the network.
 */

const FRESH = { consecutive: 0, outagePasses: 0 }

test('the parameters are the plugin\'s: floor 3, ratio 0.5, bound 5, endpoint passes 3', () => {
  assert.equal(SYSTEMIC_FAILURE_MIN_RECORDS, 3)
  assert.equal(SYSTEMIC_FAILURE_RATIO, 0.5)
  assert.equal(SYSTEMIC_MAX_CONSECUTIVE, 5)
  assert.equal(SYSTEMIC_ENDPOINT_FAILURE_PASSES, 3)
})

// failed, attempted, expected mass failure: the plugin's own table (test_systemic_failure_needs_a_floor_and_a_ratio)
for (const [failed, attempted, expected, why] of [
  [1, 1, false, 'a quiet tick with one failing order is not systemic'],
  [2, 2, false, 'below the floor'],
  [3, 3, true, 'the endpoint failed everyone who called it'],
  [3, 10, false, 'a few broken orders in a busy store are not systemic'],
  [6, 10, true, 'most of them are'],
  [5, 10, true, 'exactly the ratio counts'],
  [0, 10, false, 'no failure'],
  [3, 0, false, 'nothing attempted is nothing to be a ratio of'],
] as const) {
  test(`mass failure: ${failed} failed of ${attempted} attempted is ${expected} (${why})`, () => {
    assert.equal(isMassFailure({ attempted, failed, exhausted: failed }), expected)
  })
}

test('floor and ratio must BOTH hold: the ratio alone misfires on a quiet tick, the floor alone on a big store', () => {
  // ratio alone: 2/2 = 100% but only two records.
  assert.equal(isMassFailure({ attempted: 2, failed: 2, exhausted: 2 }), false)
  // floor alone: 3 failures, but in 200 attempts.
  assert.equal(isMassFailure({ attempted: 200, failed: 3, exhausted: 3 }), false)
  // a big store in a real outage clears both.
  assert.equal(isMassFailure({ attempted: 200, failed: 150, exhausted: 3 }), true)
})

test('a systemic pass parks nothing and counts', () => {
  const d = decideSystemicFailure({ attempted: 3, failed: 3, exhausted: 3 }, FRESH)
  assert.equal(d.verdict, 'systemic')
  assert.equal(d.next.consecutive, 1)
  assert.equal(d.incident, 'open')
  assert.equal(d.boundExceeded, false)
})

test('a quiet tick with one exhausted record is per-record: it is parked', () => {
  const d = decideSystemicFailure({ attempted: 1, failed: 1, exhausted: 1 }, FRESH)
  assert.equal(d.verdict, 'per-record')
  assert.equal(d.incident, 'resolve')
})

test('a big store with a few broken orders is per-record', () => {
  const d = decideSystemicFailure({ attempted: 100, failed: 3, exhausted: 3 }, FRESH)
  assert.equal(d.verdict, 'per-record')
})

test('the numerator is every record that FAILED, not only the ones that exhausted (staggered retry clocks)', () => {
  // During an outage 3 old records may exhaust while 97 equally broken newer ones have not: 3/100 would park them mid-outage.
  const d = decideSystemicFailure({ attempted: 100, failed: 100, exhausted: 3 }, FRESH)
  assert.equal(d.verdict, 'systemic')
})

test('suppression is BOUNDED: the sixth consecutive systemic pass isolates', () => {
  const outcomes = { attempted: 3, failed: 3, exhausted: 3 }
  let state = { ...FRESH }
  const verdicts: string[] = []
  for (let pass = 0; pass < 7; pass += 1) {
    const d = decideSystemicFailure(outcomes, state)
    verdicts.push(d.verdict)
    state = { ...state, ...d.next }
  }
  assert.deepEqual(verdicts, ['systemic', 'systemic', 'systemic', 'systemic', 'systemic', 'per-record', 'per-record'])
})

test('the bound is saturated, not reset: the pass after it keeps isolating until the fault clears', () => {
  const d = decideSystemicFailure({ attempted: 3, failed: 3, exhausted: 3 }, { consecutive: 5, outagePasses: 0 })
  assert.equal(d.verdict, 'per-record')
  assert.equal(d.boundExceeded, true)
  assert.equal(d.next.consecutive, 5)
  assert.equal(d.incident, 'escalate')
})

test('a bound that is configurable is honoured (3 consecutive)', () => {
  const params = { ...DEFAULT_SYSTEMIC_PARAMS, maxConsecutive: 3 }
  const outcomes = { attempted: 3, failed: 3, exhausted: 3 }
  assert.equal(decideSystemicFailure(outcomes, { consecutive: 2, outagePasses: 0 }, params).verdict, 'systemic')
  assert.equal(decideSystemicFailure(outcomes, { consecutive: 3, outagePasses: 0 }, params).verdict, 'per-record')
})

test('a clean pass resets the counter and resolves the incident', () => {
  const d = decideSystemicFailure({ attempted: 5, failed: 0, exhausted: 0 }, { consecutive: 4, outagePasses: 2 })
  assert.equal(d.next.consecutive, 0)
  assert.equal(d.next.outagePasses, 0)
  assert.equal(d.incident, 'resolve')
})

test('a per-record pass (attempts, no mass failure) resets the counter too', () => {
  const d = decideSystemicFailure({ attempted: 40, failed: 2, exhausted: 2 }, { consecutive: 4, outagePasses: 0 })
  assert.equal(d.verdict, 'per-record')
  assert.equal(d.next.consecutive, 0)
  assert.equal(d.incident, 'resolve')
})

test('a mass-failure pass with nothing exhausted yet leaves the counter alone: parking was not at stake', () => {
  const d = decideSystemicFailure({ attempted: 10, failed: 10, exhausted: 0 }, { consecutive: 2, outagePasses: 0 })
  assert.equal(d.verdict, 'per-record')
  assert.equal(d.next.consecutive, 2)
  assert.equal(d.incident, 'keep')
})

test('a pass that attempted nothing is no evidence either way', () => {
  const d = decideSystemicFailure({ attempted: 0, failed: 0, exhausted: 0 }, { consecutive: 3, outagePasses: 2 })
  assert.deepEqual(d.next, { consecutive: 3, outagePasses: 2 })
  assert.equal(d.incident, 'keep')
})

test('the endpoint rule: every caller failing three passes running is an outage at ANY cohort size', () => {
  let state = { ...FRESH }
  const outages: boolean[] = []
  for (let pass = 0; pass < 4; pass += 1) {
    const d = decideSystemicFailure({ attempted: 1, failed: 1, exhausted: 0 }, state)
    outages.push(d.outage)
    state = { ...state, ...d.next }
  }
  assert.deepEqual(outages, [false, false, true, true], 'one blip is not an outage, the third pass is')
  // and it never suppresses parking on its own: one record cannot be a cohort
  assert.equal(decideSystemicFailure({ attempted: 1, failed: 1, exhausted: 1 }, { consecutive: 0, outagePasses: 2 }).verdict, 'per-record')
})

test('the endpoint streak is broken by a pass in which anything succeeded', () => {
  const d = decideSystemicFailure({ attempted: 2, failed: 1, exhausted: 0 }, { consecutive: 0, outagePasses: 2 })
  assert.equal(d.next.outagePasses, 0)
  assert.equal(d.outage, false)
})

test('parseSystemicState: unreadable state is no state', () => {
  assert.deepEqual(parseSystemicState(null), EMPTY_SYSTEMIC_STATE)
  assert.deepEqual(parseSystemicState('{not json'), EMPTY_SYSTEMIC_STATE)
  assert.deepEqual(parseSystemicState('42'), EMPTY_SYSTEMIC_STATE)
  const parsed = parseSystemicState(JSON.stringify({ consecutive: 3, outagePasses: 'x', incidentOpenedAt: '2026-11-16T00:00:00.000Z', isolating: true }))
  assert.equal(parsed.consecutive, 3)
  assert.equal(parsed.outagePasses, 0)
  assert.equal(parsed.incidentOpenedAt, '2026-11-16T00:00:00.000Z')
  assert.equal(parsed.isolating, true)
})

test('the incident text names the evidence, what was not done and the limit', () => {
  const text = describeSystemicIncident({
    sweep: 'order-push', connector: 'mintsoft',
    decision: { verdict: 'systemic', boundExceeded: false, outage: false },
    outcomes: { attempted: 4, failed: 4, exhausted: 3 }, consecutive: 2, outagePasses: 0, reason: 'HTTP 500',
  })
  assert.match(text, /4 of 4 records failed/)
  assert.match(text, /NOTHING was parked/)
  assert.match(text, /2 passes running/)
  assert.match(text, /5 consecutive passes/)
  assert.match(text, /HTTP 500/)
  const isolating = describeSystemicIncident({
    sweep: 'order-push', connector: 'mintsoft',
    decision: { verdict: 'per-record', boundExceeded: true, outage: false },
    outcomes: { attempted: 4, failed: 4, exhausted: 3 }, consecutive: 5, outagePasses: 0, reason: null,
  })
  assert.match(isolating, /isolated one by one again/)
})

// --- the lifecycle over a store -------------------------------------------------------------------------------------------

function memoryStore(options: { failLoad?: boolean; failSave?: boolean; failRaise?: boolean } = {}) {
  const rows = new Map<string, SystemicState>()
  const raised: SystemicIncident[] = []
  const resolved: Array<{ sweep: string; connector: string; consecutive: number }> = []
  const flags = { ...options }
  const store: SystemicFailureStore = {
    async load(sweep) {
      if (flags.failLoad) throw new Error('db down')
      return rows.get(sweep) ?? { ...EMPTY_SYSTEMIC_STATE }
    },
    async save(sweep, state) {
      if (flags.failSave) return false
      rows.set(sweep, state)
      return true
    },
    async raise(incident) {
      if (flags.failRaise) throw new Error('notify down')
      raised.push(incident)
    },
    async resolve(info) { resolved.push(info) },
  }
  return { store, rows, raised, resolved, flags }
}

const AT = (n: number) => new Date(Date.UTC(2026, 10, 16, 0, n))
const SYSTEMIC = { attempted: 3, failed: 3, exhausted: 3 }
const CLEAN = { attempted: 3, failed: 0, exhausted: 0 }

test('lifecycle: five systemic passes raise ONE incident, the sixth isolates and says so, a clean pass resolves it', async () => {
  const m = memoryStore()
  const suppressed: boolean[] = []
  for (let pass = 1; pass <= 6; pass += 1) {
    const r = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(pass), reason: 'HTTP 500' })
    suppressed.push(r.suppress)
    if (pass <= 5) assert.equal(m.rows.get('order-push')?.consecutive, pass)
  }
  assert.deepEqual(suppressed, [true, true, true, true, true, false], 'the sixth pass parks')
  assert.equal(m.raised.length, 2, 'ONE incident for the five suppressed passes, plus the one escalation')
  assert.equal(m.raised[0].kind, 'open')
  assert.match(m.raised[0].message, /NOTHING was parked/)
  assert.equal(m.raised[1].kind, 'escalate')
  assert.match(m.raised[1].message, /isolated one by one again/, 'the incident says the sweep went back to isolating')
  assert.equal(m.rows.get('order-push')?.isolating, true)
  assert.notEqual(m.rows.get('order-push')?.incidentOpenedAt, null)

  const clean = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: CLEAN, now: AT(7) })
  assert.equal(clean.suppress, false)
  assert.equal(m.resolved.length, 1)
  assert.equal(m.rows.get('order-push')?.consecutive, 0)
  assert.equal(m.rows.get('order-push')?.incidentOpenedAt, null, 'the incident is gone')
  assert.equal(m.rows.get('order-push')?.isolating, false)
})

test('lifecycle: a per-record pass resolves the incident too', async () => {
  const m = memoryStore()
  await runSystemicPass(m.store, { sweep: 'dispatch', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(1) })
  assert.notEqual(m.rows.get('dispatch')?.incidentOpenedAt, null)
  const r = await runSystemicPass(m.store, { sweep: 'dispatch', connector: 'mintsoft', outcomes: { attempted: 50, failed: 2, exhausted: 2 }, now: AT(2) })
  assert.equal(r.suppress, false)
  assert.equal(r.decision.verdict, 'per-record')
  assert.equal(m.resolved.length, 1)
  assert.equal(m.rows.get('dispatch')?.consecutive, 0)
})

test('lifecycle: the sweeps keep separate counters', async () => {
  const m = memoryStore()
  await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(1) })
  await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(2) })
  await runSystemicPass(m.store, { sweep: 'dispatch', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(3) })
  assert.equal(m.rows.get('order-push')?.consecutive, 2)
  assert.equal(m.rows.get('dispatch')?.consecutive, 1)
  assert.equal(m.raised.length, 2, 'one incident per sweep')
})

test('lifecycle: an outage on a one-record tenant raises an incident on the third pass and parks nothing extra', async () => {
  const m = memoryStore()
  const one = { attempted: 1, failed: 1, exhausted: 0 }
  for (let pass = 1; pass <= 2; pass += 1) await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: one, now: AT(pass) })
  assert.equal(m.raised.length, 0, 'two passes is a blip')
  const third = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: one, now: AT(3) })
  assert.equal(third.suppress, false, 'the endpoint rule reports; it never withholds a park of its own')
  assert.equal(m.raised.length, 1)
  assert.match(m.raised[0].message, /Every attempt failed in 3 order-push passes/)
})

test('fail toward the old behaviour: an unreadable counter isolates rather than suppress uncounted', async () => {
  const m = memoryStore({ failLoad: true })
  const notes: string[] = []
  const r = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(1), onDegraded: (message) => notes.push(message) })
  assert.equal(r.suppress, false)
  assert.equal(r.degraded, true)
  assert.equal(m.raised.length, 0)
  assert.match(notes[0], /could not read/)
})

test('fail toward the old behaviour: a verdict that cannot be persisted is not acted on', async () => {
  const m = memoryStore({ failSave: true })
  const r = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(1) })
  assert.equal(r.suppress, false, 'an uncounted suppression would be an unbounded one')
  assert.equal(r.decision.verdict, 'per-record')
  assert.equal(r.degraded, true)
  assert.equal(m.raised.length, 0)
})

test('a failed announcement is retried on the next pass and the suppression still stands', async () => {
  const m = memoryStore({ failRaise: true })
  const first = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(1) })
  assert.equal(first.suppress, true, 'the decision is already durable')
  assert.equal(first.degraded, true)
  assert.equal(m.rows.get('order-push')?.incidentOpenedAt, null, 'the marker is cleared so the announcement is retried')
  m.flags.failRaise = false
  const second = await runSystemicPass(m.store, { sweep: 'order-push', connector: 'mintsoft', outcomes: SYSTEMIC, now: AT(2) })
  assert.equal(second.suppress, true)
  assert.equal(m.raised.length, 1)
  assert.equal(m.raised[0].consecutive, 2)
})
