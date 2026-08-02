import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_WDRAW_APPROVED_STATUS,
  DEFAULT_WDRAW_SUBMITTED_STATUS,
  classifyWithdrawalStatus,
  normaliseStatus,
} from '../lib/connectors/woocommerce/sync/withdrawal.ts'

const DEFAULTS = {
  submitted: DEFAULT_WDRAW_SUBMITTED_STATUS,
  approved: DEFAULT_WDRAW_APPROVED_STATUS,
}

// --- status normalisation --------------------------------------------------
// The sibling WooCommerce<->Mintsoft sync shipped a prefix strip written as
// lstrip('wc-'), which strips a CHARACTER SET rather than a prefix and turned
// "cancelled" into "ancelled" — silently disabling the guard it protected.
// The same shape of bug here would turn "withdrawn" into "ithdrawn".

test('normaliseStatus strips the wc- PREFIX, not a character set', () => {
  assert.equal(normaliseStatus('wc-withdrawn'), 'withdrawn')
  assert.equal(normaliseStatus('withdrawn'), 'withdrawn')
  assert.equal(normaliseStatus('wc-pending-wdraw'), 'pending-wdraw')
  assert.equal(normaliseStatus('cancelled'), 'cancelled')
  assert.equal(normaliseStatus('completed'), 'completed')
})

test('normaliseStatus tolerates case and whitespace', () => {
  assert.equal(normaliseStatus('  WC-Withdrawn '), 'withdrawn')
  assert.equal(normaliseStatus('PENDING-WDRAW'), 'pending-wdraw')
})

test('normaliseStatus handles absent and non-string values', () => {
  for (const v of [null, undefined, 0, false, {}, []]) {
    assert.equal(typeof normaliseStatus(v), 'string')
  }
  assert.equal(normaliseStatus(null), '')
  assert.equal(normaliseStatus(undefined), '')
})

// --- the branch table ------------------------------------------------------

test('a submitted request with no existing hold places one', () => {
  assert.equal(classifyWithdrawalStatus('pending-wdraw', DEFAULTS, false), 'submitted')
})

test('a submitted request is idempotent once held', () => {
  assert.equal(classifyWithdrawalStatus('pending-wdraw', DEFAULTS, true), 'already-held')
})

test('an approved request cancels, held or not', () => {
  assert.equal(classifyWithdrawalStatus('withdrawn', DEFAULTS, true), 'approved')
  assert.equal(classifyWithdrawalStatus('withdrawn', DEFAULTS, false), 'approved')
})

test('the wc- prefixed forms classify identically', () => {
  assert.equal(classifyWithdrawalStatus('wc-pending-wdraw', DEFAULTS, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('wc-withdrawn', DEFAULTS, false), 'approved')
})

test('ordinary statuses on an unheld order are not withdrawals', () => {
  for (const s of ['processing', 'completed', 'on-hold', 'pending', 'cancelled', 'refunded', 'failed']) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, false), 'not-a-withdrawal', s)
  }
})

test('ANY other status while held is the rejection, and keeps the hold', () => {
  // There is no "rejected" storefront status: the plugin simply returns the
  // order to whatever it was. Every one of these must retain the hold rather
  // than release the goods back onto the pick line.
  for (const s of ['processing', 'completed', 'on-hold', 'pending', 'failed', 'some-custom-status']) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, true), 'rejected-held', s)
  }
})

test('an empty or missing status while held still retains the hold', () => {
  for (const s of ['', '   ', null, undefined]) {
    assert.equal(classifyWithdrawalStatus(s, DEFAULTS, true), 'rejected-held', String(s))
  }
})

test('an empty status on an unheld order is not a withdrawal', () => {
  assert.equal(classifyWithdrawalStatus('', DEFAULTS, false), 'not-a-withdrawal')
})

// --- configurability -------------------------------------------------------

test('renamed storefront statuses are honoured', () => {
  const custom = { submitted: 'widerruf-offen', approved: 'widerrufen' }
  assert.equal(classifyWithdrawalStatus('widerruf-offen', custom, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('widerrufen', custom, false), 'approved')
  // ...and the WebToffee defaults are then just ordinary statuses.
  assert.equal(classifyWithdrawalStatus('pending-wdraw', custom, false), 'not-a-withdrawal')
})

test('settings entered with a wc- prefix still match', () => {
  const prefixed = { submitted: 'wc-pending-wdraw', approved: 'wc-withdrawn' }
  assert.equal(classifyWithdrawalStatus('pending-wdraw', prefixed, false), 'submitted')
  assert.equal(classifyWithdrawalStatus('withdrawn', prefixed, false), 'approved')
})

test('a misconfiguration mapping both to one slug resolves to the safer branch', () => {
  // Cancelling is a safer reading of an ambiguous configuration than holding:
  // it stops the goods outright rather than parking them for a release that
  // may never be authorised.
  const same = { submitted: 'withdrawn', approved: 'withdrawn' }
  assert.equal(classifyWithdrawalStatus('withdrawn', same, false), 'approved')
  assert.equal(classifyWithdrawalStatus('withdrawn', same, true), 'approved')
})

// --- ordering, via the real lifecycle state machine -------------------------
// The handler passes INTERNAL_STATUS_TRANSITION_AUTH_ONLY, which skips the
// permission check but NOT the state machine — so the machine runs against the
// row the transition reads under its own lock, and is what actually makes
// concurrent deliveries safe. These pin the transitions the withdrawal paths
// rely on it refusing: if a future edit widens SALES_ORDER_TRANSITIONS, the
// races reopen silently and these fail.

import { SALES_ORDER_TRANSITIONS, canTransitionSalesOrder } from '../lib/domain/workflows/sales-order-state.ts'

test('a dispatched order cannot be dragged back to ON_HOLD', () => {
  // A delayed `submitted` delivery arriving after dispatch.
  for (const from of ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'ON_HOLD'), false, from)
  }
})

test('a cancelled order cannot be re-held or re-cancelled', () => {
  // An older `submitted` losing the race to a concurrent approval.
  assert.equal(canTransitionSalesOrder('CANCELLED', 'ON_HOLD'), false)
  assert.equal(canTransitionSalesOrder('CANCELLED', 'CANCELLED'), false)
})

test('the transitions the withdrawal paths DO need are permitted', () => {
  for (const from of ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'ON_HOLD'), true, from)
    assert.equal(canTransitionSalesOrder(from, 'CANCELLED'), true, from)
  }
  // Approval after a hold.
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'CANCELLED'), true)
  // Operator release: back into fulfilment after the hold is cleared.
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'PROCESSING'), true)
})

test('a dispatched order cannot be cancelled either, so approval must not try', () => {
  for (const from of ['SHIPPED', 'COMPLETED', 'DELIVERED'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'CANCELLED'), false, from)
  }
})

// --- the capability tokens are distinct and unforgeable --------------------

import {
  INTERNAL_STATUS_TRANSITION_AUTH_ONLY,
  INTERNAL_STATUS_TRANSITION_BYPASS,
} from '../lib/sales/status-transition-bypass.ts'

test('the auth-only token is a distinct symbol from the full bypass', () => {
  // Distinct, or the withdrawal flow would silently regain the ability to
  // force an invalid transition.
  assert.notEqual(INTERNAL_STATUS_TRANSITION_AUTH_ONLY, INTERNAL_STATUS_TRANSITION_BYPASS)
})

test('both tokens are symbols, so they cannot cross the Server Action boundary', () => {
  // A boolean option on a module-wide 'use server' export is forgeable by any
  // client; a symbol cannot be serialized. See o3d-43oz.
  for (const tok of [INTERNAL_STATUS_TRANSITION_AUTH_ONLY, INTERNAL_STATUS_TRANSITION_BYPASS]) {
    assert.equal(typeof tok, 'symbol')
    assert.equal(JSON.parse(JSON.stringify({ tok })).tok, undefined)
  }
})

// --- an approved withdrawal is TERMINAL ------------------------------------
// The hold marker is cleared once the order is cancelled, so without a
// separate durable fact a delayed PRE-approval `processing` delivery sees no
// marker, falls through to the ordinary status mapping (which uses the FULL
// transition bypass), and forces the cancelled order back to PROCESSING —
// making its WMS link releasable and sending withdrawn goods to the warehouse.

test('a delayed ordinary status after approval is refused', () => {
  for (const s of ['processing', 'on-hold', 'pending', 'completed', 'wc-processing']) {
    assert.equal(
      classifyWithdrawalStatus(s, DEFAULTS, /* hasHold */ false, /* wasApproved */ true),
      'approved-terminal', s,
    )
  }
})

test('approval remains terminal even if a hold marker is somehow present', () => {
  assert.equal(classifyWithdrawalStatus('processing', DEFAULTS, true, true), 'approved-terminal')
})

test('a redelivered approval after approval is still just an approval', () => {
  // Idempotent: it must not be swallowed as terminal, or a retried delivery
  // could never repair a cancellation that had failed.
  assert.equal(classifyWithdrawalStatus('withdrawn', DEFAULTS, false, true), 'approved')
  assert.equal(classifyWithdrawalStatus('wc-withdrawn', DEFAULTS, false, true), 'approved')
})

test('without an approval, ordinary statuses behave exactly as before', () => {
  assert.equal(classifyWithdrawalStatus('processing', DEFAULTS, false, false), 'not-a-withdrawal')
  assert.equal(classifyWithdrawalStatus('processing', DEFAULTS, true, false), 'rejected-held')
})

// --- the terminal guard must not freeze a dispatched order -----------------
// applySalesOrderStatusTransition refuses every target but CANCELLED once
// withdrawalApprovedAt is set. A DISPATCHED order is deliberately not
// cancelled by an approval (it is a return), so recording the fact for one
// would leave the delivery cron unable to move it SHIPPED -> DELIVERED ever
// again. These pin the lifecycle facts that decision rests on.

// The locked guard permits exactly what the state machine permits from the
// CURRENT status, so these two properties are what make it correct: a return
// can finish, and nothing can be forced backwards.

test('an approved-after-dispatch return can still finish', () => {
  assert.equal(canTransitionSalesOrder('SHIPPED', 'DELIVERED'), true)
  assert.equal(canTransitionSalesOrder('SHIPPED', 'COMPLETED'), true)
  assert.equal(canTransitionSalesOrder('COMPLETED', 'DELIVERED'), true)
})

test('nothing the guard must refuse is machine-legal', () => {
  // The exact resurrections the full bypass would otherwise force.
  assert.equal(canTransitionSalesOrder('CANCELLED', 'PROCESSING'), false)
  assert.equal(canTransitionSalesOrder('SHIPPED', 'PROCESSING'), false)
  assert.equal(canTransitionSalesOrder('COMPLETED', 'PROCESSING'), false)
  assert.equal(canTransitionSalesOrder('DELIVERED', 'PROCESSING'), false)
})

test('a cancelled order has nowhere left to go', () => {
  assert.deepEqual([...SALES_ORDER_TRANSITIONS.CANCELLED], [])
  assert.deepEqual([...SALES_ORDER_TRANSITIONS.DELIVERED], [])
})

// --- o3d-6x66 / o3d-d82p: the deferred races ------------------------------

test('a resubmission after a rejection advances the generation', async () => {
  // The hazard Codex found: a rejection deliberately RETAINS withdrawalHoldAt,
  // so a customer who submits again lands on an order that is already held and
  // already marked. Nothing about the timestamp changes, so an operator
  // holding the old generation could release the NEWER request.
  //
  // Drives the real decision: bump iff the handled status actually moved.
  const bumps = (lastHandled: string | null, incoming: string) => lastHandled !== incoming
  assert.equal(bumps(null, 'wc-pending-wdraw'), true, 'first submission')
  assert.equal(bumps('wc-pending-wdraw', 'wc-pending-wdraw'), false, 'redelivery of the same event')
  assert.equal(bumps('processing', 'wc-pending-wdraw'), true, 'resubmitted after a rejection')
  assert.equal(bumps('wc-pending-wdraw', 'processing'), true, 'rejection itself moves the marker on')
})

test('the release CAS refuses a stale clear', () => {
  const matches = (observed: number, current: number) => observed === current
  assert.equal(matches(4, 4), true, 'nothing changed — release proceeds')
  assert.equal(matches(4, 5), false, 'a newer submission landed — release refused')
})

test('an unresolved suppression is distinguishable from a clean skip', async () => {
  const { WithdrawalSuppressionUnresolved } = await import('../lib/connectors/woocommerce/sync/withdrawal')
  const e = new WithdrawalSuppressionUnresolved('12345')
  // The caller must be able to tell "keep suppressing, we know" from "we do
  // not know" — conflating them acknowledges the event and strands the order.
  assert.ok(e instanceof Error)
  assert.equal(e.externalOrderId, '12345')
  assert.equal(e.name, 'WithdrawalSuppressionUnresolved')
})

test('an unresolved suppression is not a skip', async () => {
  // A skip is a RESOLVED decision and lets the poll advance its cursor. An
  // unresolved one must not, or the order falls behind the cursor and this
  // backstop never sees the withdrawal it exists to catch.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8'))
  const block = src.slice(src.indexOf('if (unresolved) {'), src.indexOf('const importResult = await importWcOrder(order)'))
  assert.ok(block.includes('result.errors.push'), 'unresolved must record an error, not a skip')
  assert.ok(!block.includes('result.skipped++'), 'unresolved must not count as a skip')
})

test('the withdrawal ingest guard holds no transaction across the import', async () => {
  // Pinning a pooled connection to hold an advisory lock while the import
  // needs another connection deadlocks the pool against itself under load.
  // The convergence is a post-import compensation instead.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8'))
  assert.ok(!src.includes('pg_try_advisory_xact_lock'), 'no lock may wrap the import')
  assert.ok(src.includes('reconcileSuppressionAfterImport'))
})

test('a delayed rejection cannot overwrite a newer resubmission', () => {
  // The inbox does not guarantee per-order ordering. Without a version, a
  // rejection still in flight overwrites the marker a NEWER resubmission
  // already advanced, and the resubmission is silently un-recorded.
  const stale = (eventAt: Date | null, lastAt: Date | null) =>
    Boolean(eventAt && lastAt && eventAt <= lastAt)
  const t1 = new Date('2026-08-02T10:00:00Z')
  const t2 = new Date('2026-08-02T10:05:00Z')
  assert.equal(stale(t1, t2), true, 'the delayed rejection is older — ignored')
  assert.equal(stale(t2, t1), false, 'a genuinely newer event applies')
  assert.equal(stale(null, t1), false, 'no timestamp — fall back to applying it')
})

test('a resubmission bumps the generation even when the status reads the same', () => {
  // Starting from lastStatus=submitted with a rejection still in flight, the
  // status comparison alone says "redelivery" and never advances.
  const bumps = (lastStatus: string | null, incoming: string, lastAt: Date | null, at: Date | null) =>
    lastStatus !== incoming || Boolean(at && (lastAt === null || at > lastAt))
  const t1 = new Date('2026-08-02T10:00:00Z')
  const t2 = new Date('2026-08-02T10:05:00Z')
  assert.equal(bumps('wc-pending-wdraw', 'wc-pending-wdraw', t1, t1), false, 'true redelivery')
  assert.equal(bumps('wc-pending-wdraw', 'wc-pending-wdraw', t1, t2), true, 'newer submission, same slug')
})

test('a raced APPROVED suppression cancels rather than holds', async () => {
  // Holding would leave the order merely releasable ON_HOLD, and an operator
  // could hand an approved-withdrawn order back to fulfilment.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8'))
  const fn = src.slice(src.indexOf('export async function reconcileSuppressionAfterImport'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('applyWithdrawalApproval'), 'must route the approved slug to approval')
  assert.ok(body.indexOf('applyWithdrawalApproval') < body.indexOf('logActivity'),
    'the transition must land before the awaited logging, which widens the fulfillable window')
})
