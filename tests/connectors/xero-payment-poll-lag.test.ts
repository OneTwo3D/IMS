import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LAG_ALERT_FLOOR_MS,
  LAG_STALL_POLLS,
  MIN_LAG_PROGRESS_MS,
  assessCursorLag,
  parseCursorLagState,
} from '@/lib/connectors/xero/payment-poll-lag'

/**
 * o3d-pzu0 — A DRAIN THAT RUNS FOREVER AND NEVER CATCHES UP LOOKS EXACTLY LIKE A HEALTHY ONE.
 *
 * The bounded drain caps unique progress at MAX_CHUNKS_PER_POLL * MAX_PAGES * PAGE_SIZE rows per
 * run. At sustained ingress at or above that rate the cursor lag cannot shrink, and payment
 * detection is delayed indefinitely rather than recovering. The only signal today is
 * `xero_payment_poll_backlog_draining` at WARNING, which is emitted by a drain that IS making
 * progress as well — so an operator has learned it means "it is working".
 *
 * This decides, from the lag alone across polls, whether the drain is converging. It is pure so the
 * decision can be pinned without a poller, a clock, or Xero.
 */

const HOUR = 60 * 60_000

test('a lag below the alert floor is the normal steady state and never escalates (o3d-pzu0)', () => {
  // The poll runs every 15 minutes and reads with an overlap, so SOME lag is always present.
  // Alerting on it would train the operator to ignore the alert.
  for (const lag of [0, 60_000, LAG_ALERT_FLOOR_MS - 1]) {
    const assessment = assessCursorLag({ lagMs: 10 * HOUR, stalledPolls: LAG_STALL_POLLS + 3 }, lag)
    assert.equal(assessment.escalate, false, `lag ${lag} must not escalate`)
    assert.equal(assessment.next.stalledPolls, 0, 'and a healthy lag clears the stall counter')
  }
})

test('one reading is never a stall — there is nothing to compare it against (o3d-pzu0)', () => {
  // Null-totality: the first poll after a deploy, or after the setting is cleared, has no prior
  // lag. Treating "unknown" as "no progress" would escalate a drain nobody has watched yet.
  const assessment = assessCursorLag(null, 6 * HOUR)
  assert.equal(assessment.escalate, false)
  assert.equal(assessment.next.stalledPolls, 0)
  assert.equal(assessment.progressMs, null, 'no prior reading means no progress figure, not zero')
})

test('a drain that removes real lag resets the counter (o3d-pzu0)', () => {
  const assessment = assessCursorLag({ lagMs: 6 * HOUR, stalledPolls: 3 }, 5 * HOUR)
  assert.equal(assessment.next.stalledPolls, 0)
  assert.equal(assessment.escalate, false)
  assert.equal(assessment.progressMs, HOUR)
})

test('shaving seconds off an hours-long backlog does NOT count as progress (o3d-pzu0)', () => {
  // THE WHOLE POINT. "Any decrease counts" is the rule that hides the stall: a drain crawling
  // forward by a second a poll would reset the counter forever while never catching up.
  let state = { lagMs: 6 * HOUR, stalledPolls: 0 }
  let lag = 6 * HOUR
  let escalations = 0
  for (let poll = 1; poll <= LAG_STALL_POLLS + 1; poll++) {
    lag -= MIN_LAG_PROGRESS_MS - 1_000
    const assessment = assessCursorLag(state, lag)
    state = assessment.next
    if (assessment.escalate) escalations++
  }
  assert.ok(escalations > 0, 'a drain moving less than a minute a poll must eventually escalate')
})

test('it takes LAG_STALL_POLLS consecutive non-progressing polls, not one (o3d-pzu0)', () => {
  let state: { lagMs: number; stalledPolls: number } = { lagMs: 6 * HOUR, stalledPolls: 0 }
  const escalated: boolean[] = []
  for (let poll = 1; poll <= LAG_STALL_POLLS + 1; poll++) {
    const assessment = assessCursorLag(state, 6 * HOUR)
    state = assessment.next
    escalated.push(assessment.escalate)
  }
  // The first LAG_STALL_POLLS-1 polls only count; the one that reaches the threshold escalates.
  assert.deepEqual(
    escalated.slice(0, LAG_STALL_POLLS - 1),
    new Array(LAG_STALL_POLLS - 1).fill(false),
    'a single flat poll is not yet a stall',
  )
  assert.equal(escalated[LAG_STALL_POLLS - 1], true, 'the LAG_STALL_POLLS-th consecutive one is')
})

test('it keeps escalating while the stall lasts — an alert that stops looks resolved (o3d-pzu0)', () => {
  const deep = { lagMs: 6 * HOUR, stalledPolls: LAG_STALL_POLLS + 10 }
  assert.equal(assessCursorLag(deep, 6 * HOUR).escalate, true)
})

test('lag that GROWS is a stall, not merely an absence of progress (o3d-pzu0)', () => {
  // Ingress outrunning the drain is the failure this issue is about, and negative progress must not
  // read as progress through a sign error.
  const assessment = assessCursorLag({ lagMs: 5 * HOUR, stalledPolls: LAG_STALL_POLLS - 1 }, 6 * HOUR)
  assert.equal(assessment.progressMs, -HOUR)
  assert.equal(assessment.escalate, true)
})

test('a negative lag is clamped rather than trusted (o3d-pzu0)', () => {
  // The cursor is written from Xero-derived timestamps and the poll start is this host's clock, so
  // a cursor slightly ahead of "now" is a clock-skew artefact, not a negative backlog.
  const assessment = assessCursorLag({ lagMs: 6 * HOUR, stalledPolls: 2 }, -5_000)
  assert.equal(assessment.next.lagMs, 0)
  assert.equal(assessment.escalate, false)
})

test('the persisted state survives a round trip and garbage reads as absent (o3d-pzu0)', () => {
  const state = { lagMs: 3 * HOUR, stalledPolls: 2 }
  assert.deepEqual(parseCursorLagState(JSON.parse(JSON.stringify(state))), state)
  for (const bad of [null, undefined, '', 'not json', {}, { lagMs: 'x', stalledPolls: 1 }, { lagMs: 1 }, [], 7]) {
    assert.equal(parseCursorLagState(bad), null, `${JSON.stringify(bad)} must read as absent`)
  }
})
