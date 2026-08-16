import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createServerRenderMarkerSource,
  nextServerRenderMarker,
  observeServerRender,
} from '@/lib/domain/accounting/server-render-marker'

// ---------------------------------------------------------------------------
// o3d-osl8 round 8, finding 4 — the render marker had no ORDER.
//
// Round 7 handed the connector-orphan banner an ISO timestamp per server render and let it compare
// with `!==`. That answers "is this a different render?", which is not the question: an OLDER
// payload delivered late — a cached RSC response, an out-of-order delivery — differs too, and
// counted as a completed refresh. The marker is now monotonic and the comparison is `>`.
//
// What it still cannot establish is causality with the cancel attempt, and the module says so
// rather than implying otherwise; the banner's wording is asserted in stranded-sync-page.test.ts.
// ---------------------------------------------------------------------------

test('markers advance even when the clock does not', () => {
  // Two renders inside the same millisecond are ordinary. Returning the same value for both would
  // make a genuine refresh indistinguishable from no refresh at all.
  const next = createServerRenderMarkerSource(() => 1_000)

  const [a, b, c] = [next(), next(), next()]

  assert.ok(b > a && c > b, `strictly increasing, got ${a}, ${b}, ${c}`)
})

test('a clock that steps BACKWARDS cannot produce a marker that looks older', () => {
  // An NTP correction is the realistic case. If the marker went backwards, the very next render
  // would be reported as "no refresh has arrived" — and, worse, a later render could be reported as
  // earlier than one already on screen.
  let now = 5_000
  const next = createServerRenderMarkerSource(() => now)

  const first = next()
  now = 4_000
  const second = next()

  assert.ok(second > first, 'the clamp holds, so ordering survives the clock')
})

test('markers track the clock when it does move forwards', () => {
  // The clamp must not turn the source into a bare counter: values from different server workers
  // are compared to nothing, but they must stay wall-clock-plausible rather than drifting into a
  // per-process sequence.
  let now = 1_000
  const next = createServerRenderMarkerSource(() => now)

  next()
  now = 9_999
  assert.equal(next(), 9_999)
})

test('the process-wide source is one of these, not a fresh value per import', () => {
  const first = nextServerRenderMarker()
  const second = nextServerRenderMarker()

  assert.equal(typeof first, 'number')
  assert.ok(second > first)
})

test('only a STRICTLY GREATER marker counts as a newer render', () => {
  // The three cases the banner keys its wording on. `!==` — the round-7 comparison — would report
  // the last of these as a completed refresh.
  assert.deepEqual(observeServerRender({ current: 2, whenRequested: 1 }), { newerRenderArrived: true })
  assert.deepEqual(observeServerRender({ current: 1, whenRequested: 1 }), { newerRenderArrived: false })
  assert.deepEqual(
    observeServerRender({ current: 1, whenRequested: 2 }),
    { newerRenderArrived: false },
    'an older payload arriving late is not a refresh, however different it is',
  )
})
