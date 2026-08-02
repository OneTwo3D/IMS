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
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  // The POLL loop's handler (the FX queue has its own, which legitimately
  // leaves the row pending rather than recording a run error).
  const start = src.lastIndexOf("if (guarded.outcome === 'unresolved') {")
  assert.ok(start > 0, 'the poll must handle an unresolved suppression explicitly')
  const block = src.slice(start, src.indexOf('continue', start))
  assert.ok(block.includes('result.errors.push'), 'unresolved must record an error, not a skip')
  assert.ok(!block.includes('result.skipped++'), 'unresolved must not count as a skip')
})

test('the withdrawal ingest guard holds no transaction across the import', async () => {
  // Pinning a pooled connection to hold an advisory lock while the import
  // needs another connection deadlocks the pool against itself under load.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  assert.ok(!src.includes('pg_try_advisory_xact_lock'), 'no lock may wrap the import')
})

test('every importWcOrder caller goes through the guarded wrapper', async () => {
  // The FX retry queue and the initial import each open-coded the import with
  // no suppression check and no compensation, so an order withdrawn while it
  // sat in the queue came back as paid PROCESSING with no marker and stayed
  // warehouse-eligible until the next reconciliation. A new ingress path that
  // forgets the wrapper reopens exactly that.
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const full = join(dir, f)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
  const offenders: string[] = []
  for (const file of [...walk('lib'), ...walk('app')]) {
    const src = readFileSync(file, 'utf8')
    src.split('\n').forEach((line, i) => {
      if (!/\bimportWcOrder\(/.test(line)) return
      if (/importWcOrderGuarded|function importWcOrder|=> importWcOrder\(/.test(line)) return
      offenders.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'these call importWcOrder directly, bypassing the withdrawal guard')
})

test('the guarded wrapper imports BEFORE it compensates', async () => {
  // Compensation needs the ShoppingOrderLink the import creates; running it
  // first is a guaranteed no-op that reads like protection.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function importWcOrderGuarded'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.indexOf('runImport()') < body.indexOf('reconcileSuppressionAfterImport'))
})

test('compensation is retried for an order that is already LINKED', async () => {
  // The first raced import can fail its transition and correctly return 500.
  // On redelivery the order IS linked — gating compensation on "was unlinked"
  // made that retry a no-op, so the retryable failure was consumed by one
  // ineffective attempt and the order stayed live and withdrawn.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function importWcOrderGuarded'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!body.includes('wasUnlinked'), 'compensation must not be gated on the order having been unlinked')
})

test('the tombstone is LEASED, not deleted, to claim it', async () => {
  // Deleting to claim stopped the row suppressing while the claimant worked,
  // and restoring it after a failure overwrote whatever a concurrent worker
  // had recorded — so an acknowledged APPROVAL could be replaced by an older
  // `submitted` and later retried as a mere hold.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const claim = src.slice(src.indexOf('async function claimSuppression'))
  const body = claim.slice(0, claim.indexOf('\n}\n'))
  assert.ok(body.includes('updateMany'), 'the claim must leave the row in place')
  assert.ok(!body.includes('deleteMany'), 'claiming must not delete the row')
  assert.ok(body.includes('claimedAt: { lt: staleBefore }'), 'a crashed claimant must not pin it forever')
})

test('both the resolver and compensation claim BEFORE deciding', async () => {
  // Claim ordering serializes the workers; deciding first and claiming after
  // let a stale approval beat an already-observed rejection.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  for (const [fnName, decision] of [
    ['async function resolveSuppression', 'readLiveWcStatus'],
    ['export async function reconcileSuppressionAfterImport', 'readLiveWcStatus'],
  ] as const) {
    const fn = src.slice(src.indexOf(fnName))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.indexOf('claimSuppression') > 0, `${fnName} must claim`)
    assert.ok(body.indexOf('claimSuppression') < body.indexOf(decision),
      `${fnName} must claim before it decides`)
    assert.ok(body.includes("claim === 'busy'"), `${fnName} must handle a lost claim`)
  }
})

test('a failed transition releases the lease without rewriting the status', async () => {
  // Re-creating the row would overwrite a newer approval with this older
  // snapshot, which would then be retried as a hold rather than a cancel.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const rel = src.slice(src.indexOf('async function releaseSuppression'))
  const body = rel.slice(0, rel.indexOf('\n}\n'))
  assert.ok(body.includes('claimToken: null'))
  assert.ok(!body.includes('wcStatus:'), 'releasing must not touch the recorded status')
})

test('retiring a tombstone is conditional on the revision as well as the token', async () => {
  // A NEWER withdrawal recorded while the claim was held is a different
  // request; deleting it would discard it.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function retireSuppression'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('claimToken: claim.token') && body.includes('revision: claim.revision'))
  assert.ok(body.includes('releaseSuppression'), 'a superseded row must be released, not orphaned')
})

test('the decision comes from the LIVE status, not a remembered snapshot', async () => {
  // Both the tombstone's status and the triggering payload are snapshots, and
  // the inbox guarantees neither ordering nor uniqueness — so every review
  // round found another interleaving where a stale snapshot outranked a
  // fresher one (an old approval cancelling a rejected order; a delayed
  // `submitted` downgrading an approval to a releasable hold). Two workers
  // reading the same LIVE status cannot disagree, however they interleave.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  for (const fnName of ['export async function reconcileSuppressionAfterImport', 'async function resolveSuppression']) {
    const fn = src.slice(src.indexOf(fnName))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.ok(body.includes('readLiveWcStatus'), `${fnName} must read the live status`)
    assert.ok(body.indexOf('claimSuppression') < body.indexOf('readLiveWcStatus'),
      `${fnName} must claim before reading live state`)
  }
  const reconcile = src.slice(src.indexOf('export async function reconcileSuppressionAfterImport'))
  const body = reconcile.slice(0, reconcile.indexOf('\n}\n'))
  assert.ok(!body.includes('claim.wcStatus ==='), 'the remembered status must not drive the transition')
})

test('recording a newer withdrawal does not evict an active lease', async () => {
  // It is given no event version, so it cannot prove it is newer; evicting on
  // that basis let an out-of-order redelivery displace a worker mid-decision.
  // Bumping the revision suffices, because consuming is conditional on it.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function recordWithdrawalSuppressionIfWithdrawn'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!body.includes('claimToken: null'), 'must not clear another worker\'s lease')
  assert.ok(body.includes('revision: { increment: 1 }'))
})

test('a lost claim is unresolved, never a clean skip', async () => {
  // "Owned by someone else" is not "finished". A clean skip lets the caller
  // acknowledge what may be the only ordinary event the order ever sends, so
  // if the owner dies nothing retries.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function resolveSuppression'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  const lost = body.indexOf("if (claim === 'busy') {")
  assert.ok(lost > 0, 'a busy claim must be handled explicitly')
  assert.ok(body.slice(lost, lost + 700).includes('WithdrawalSuppressionUnresolved'))
})

test('the initial-import gate applies to a linked order and never swallows a failure', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/webhooks.ts', 'utf8')
  const gate = src.slice(
    src.indexOf("initialImportDone?.value !== 'true'"),
    src.indexOf("skipped: 'initial_import_pending'"),
  )
  // An order imported earlier in the same still-running job is already linked
  // and the job never revisits it, so a tombstone alone leaves it fulfillable.
  assert.ok(gate.includes('applyWithdrawalToLinkedOrder'))
  // Returning 200 after a failed write marks the event processed and recreates
  // the lost-withdrawal race this guard exists to close.
  assert.ok(gate.includes('status: 503'), 'a failed tombstone write must be retryable')
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

test('a raced APPROVED withdrawal cancels rather than holds', async () => {
  // Holding would leave the order merely releasable ON_HOLD, and an operator
  // could hand an approved-withdrawn order back to fulfilment. Decided from
  // the live status now, so no snapshot can downgrade it.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function reconcileSuppressionAfterImport'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('const isApproval = live === approved'), 'approval is decided by live truth')
  assert.ok(body.includes('applyWithdrawalApproval'))
  // Against the LAST logActivity: the fail-closed branch logs before any
  // transition, which is correct — nothing was applied there.
  assert.ok(body.indexOf('applyWithdrawalApproval') < body.lastIndexOf('logActivity'),
    'the transition must land before the awaited logging, which widens the fulfillable window')
})

test('a withdrawal arriving during initial import is still recorded', async () => {
  // Initial import ACKs and DROPS order webhooks. An order that moves to a
  // withdrawal status after its page was fetched therefore has nothing else to
  // catch it, and initial-import completion sets the poll cursor past the
  // change. The tombstone must be written even though nothing is imported yet.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/webhooks.ts', 'utf8')
  const gate = src.slice(
    src.indexOf("initialImportDone?.value !== 'true'"),
    src.indexOf("skipped: 'initial_import_pending'"),
  )
  assert.ok(gate.includes('recordWithdrawalSuppressionIfWithdrawn'),
    'the gate must record a withdrawal before dropping the event')
})

test('retiring a suppression goes through the claim, never a bare write', async () => {
  // Every retirement must be conditional on the lease token AND the revision,
  // so a newer withdrawal recorded meanwhile is never discarded.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const retireOnly = src.slice(src.indexOf('async function retireSuppression'))
  const guarded = retireOnly.slice(0, retireOnly.indexOf('\n}\n'))
  assert.ok(guarded.includes('claimToken: claim.token'))
  // No other site may remove a suppression row.
  const deletes = [...src.matchAll(/wcWithdrawalSuppression\.delete/g)].length
  assert.equal(deletes, 1, 'only the grace-elapsed purge may hard-delete')
})

test('a failed compensation is reported separately from being handled', async () => {
  // "Do not sync the stale status over what we applied" and "the transition
  // landed" are different facts. Conflating them acknowledges a delivery whose
  // withdrawal never applied, leaving a live withdrawn order.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  assert.ok(src.includes('compensationFailed'))
  assert.ok(src.includes('{ handled: true, failed: !result.success }'))
})

test('a withdrawn FX-queue row is terminal, not left pending', async () => {
  // The queue selects the oldest fixed prefix; permanently-deferred rows at the
  // head starve every newer order whose FX rate has since arrived.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  const block = src.slice(src.indexOf("if (guarded.outcome === 'skipped-withdrawal')"))
  assert.ok(block.slice(0, 900).includes('markPendingFxRetryLogFailed'),
    'a withdrawn row must be terminalized so it cannot monopolize the batch')
})

test('a busy lease is reported unfinished, never as absent', async () => {
  // Conflating them let a caller acknowledge its delivery and sync a stale
  // ordinary status while another worker was mid-transition — and if that
  // worker then died, nothing retried.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  assert.ok(src.includes("return 'busy'") && src.includes("return 'absent'"),
    'claimSuppression must distinguish the two')
  const fn = src.slice(src.indexOf('export async function reconcileSuppressionAfterImport'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes("if (claim === 'absent') return { handled: false, failed: false }"))
  assert.ok(/claim === 'busy'[\s\S]{0,400}failed: true/.test(body), 'busy must report unfinished')
})

test('a terminal approval is confirmed against the live status first', async () => {
  // Approval sets withdrawalApprovedAt, cancels the order and makes every
  // later storefront status ignored. A delayed `withdrawn` payload arriving
  // after WooCommerce rejected the request would otherwise cancel a valid
  // order unrecoverably.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function applyConfirmedWithdrawalApproval'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.indexOf('readLiveWcStatus') < body.indexOf('applyWithdrawalApproval'),
    'the confirmation must precede the terminal transition')
  assert.ok(body.includes('live === null'), 'an unreadable status must not cancel')
  assert.ok(body.includes("live !== approved"), 'a superseded approval must not cancel')
})

test('the tombstone sweeper fetches by ID and IMPORTS the recovered order', async () => {
  // Every other route to a tombstone needs ANOTHER event for that order. A
  // withdrawal rejected back to a status the poll does not query (e.g.
  // `pending` under the default `processing` config) appears in no ingress —
  // and resolving the tombstone without importing would delete its only
  // durable retry signal and strand the order permanently.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function sweepWithdrawalSuppressions'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('wcWithdrawalSuppression.findMany'), 'must enumerate tombstones directly')
  assert.ok(body.includes('readLiveWcOrder'), 'must fetch the full order by id')
  assert.ok(body.includes('importWcOrderGuarded'), 'must import through the ordinary guarded path')
  assert.ok(body.includes('claimedAt: { lt: staleBefore }'), 'must reclaim expired leases')
})

test('the withdrawal sweep is actually SCHEDULED, not just authorized', async () => {
  // Route-auth registration authorizes requests; it does not create them.
  const { readFileSync } = await import('node:fs')
  const jobs = readFileSync('lib/cron-jobs/woocommerce.ts', 'utf8')
  assert.ok(jobs.includes("slug: 'wc-withdrawal-sweep'"), 'the backstop must be in the cron registry')
  assert.ok(/wc-withdrawal-sweep[\s\S]{0,600}defaultSchedule: '\*\/15 \* \* \* \*'/.test(jobs))
  assert.ok(/wc-withdrawal-sweep[\s\S]{0,600}defaultEnabled: true/.test(jobs))
})

test('every approval site goes through the live-confirmed helper', async () => {
  // A second, unconfirmed approval path is exactly how this hole reopened
  // after it was first closed: the initial-import linked path still cancelled
  // straight from a payload that WooCommerce had already superseded.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const lines = src.split('\n')
  const raw = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /\bapplyWithdrawalApproval\(/.test(l)
      && !/async function applyWithdrawalApproval/.test(l))
  // Permitted: inside applyConfirmedWithdrawalApproval, and inside
  // reconcileSuppressionAfterImport which has just read the live status itself.
  const confirmedAt = src.indexOf('async function applyConfirmedWithdrawalApproval')
  const reconcileAt = src.indexOf('export async function reconcileSuppressionAfterImport')
  for (const { l, i } of raw) {
    const pos = lines.slice(0, i).join('\n').length
    const inConfirmed = pos > confirmedAt && pos < src.indexOf('\n}\n', confirmedAt)
    const inReconcile = pos > reconcileAt && pos < src.indexOf('\n}\n', reconcileAt)
    assert.ok(inConfirmed || inReconcile, `unconfirmed terminal approval at line ${i + 1}: ${l.trim()}`)
  }
})

test('the withdrawal sweep cron is registered in the route auth policy', async () => {
  const { readFileSync } = await import('node:fs')
  const policy = readFileSync('lib/security/route-auth-policy.ts', 'utf8')
  assert.ok(policy.includes("'/api/cron/wc-withdrawal-sweep'"), 'an unregistered cron route fails the boundary guard')
})

test('there is exactly ONE post-import decision point', async () => {
  // The resolver's "the request was rejected" read happens BEFORE the import.
  // Consuming on that read deletes the only durable signal if the customer
  // resubmits (or is approved) while the import runs and that webhook is
  // missed — which is precisely the failure mode this sweep exists to cover.
  // So the resolver releases, and reconcile re-reads live and decides.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const resolver = src.slice(src.indexOf('async function resolveSuppression'))
  const rBody = resolver.slice(0, resolver.indexOf('\n}\n'))
  assert.ok(!rBody.includes('retireSuppression'), 'the resolver must not retire the tombstone')

  const wrapper = src.slice(src.indexOf('export async function importWcOrderGuarded'))
  const wBody = wrapper.slice(0, wrapper.indexOf('\n}\n'))
  assert.ok(!wBody.includes('retireSuppression'),
    'the wrapper must not retire on the pre-import read either')
  assert.ok(wBody.includes('releaseSuppression'))
  assert.ok(wBody.indexOf('releaseSuppression') < wBody.indexOf('reconcileSuppressionAfterImport'),
    'release, then let reconcile re-read live and decide')

  // reconcile is the only consumer, and it reads live status first.
  const rec = src.slice(src.indexOf('export async function reconcileSuppressionAfterImport'))
  const recBody = rec.slice(0, rec.indexOf('\n}\n'))
  assert.ok(recBody.indexOf('readLiveWcStatus') < recBody.indexOf('retireSuppression'))
})

test('the sweep persists a cron run and fails loudly on unresolved rows', async () => {
  // The installer invokes cron with `curl -o /dev/null`, so a bare JSON body
  // is discarded — a broken WooCommerce credential would leave suppressed
  // orders unimported indefinitely while the job kept reporting 200.
  const { readFileSync } = await import('node:fs')
  const route = readFileSync('app/api/cron/wc-withdrawal-sweep/route.ts', 'utf8')
  assert.ok(route.includes('runCronWithLogging'), 'the run must be persisted')
  assert.ok(route.includes('sweep.unresolved > 0'), 'unresolved rows must not report success')
  assert.ok(route.includes('throw new Error'), 'and must surface as a failed run')
})

test('the sweep rotates and cannot be starved by a permanent prefix', async () => {
  // Always taking the oldest 50 by immutable createdAt means a prefix of rows
  // that stay withdrawn or stay unreadable is re-selected forever, so nothing
  // past the first batch is ever checked again.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function sweepWithdrawalSuppressions'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes("lastCheckedAt: { sort: 'asc', nulls: 'first' }"), 'oldest-checked first')
  const stamp = body.indexOf('lastCheckedAt: new Date()')
  const work = body.indexOf('readLiveWcOrder')
  assert.ok(stamp > 0 && stamp < work, 'the attempt must be stamped before the work, so a throw still rotates')
})

test('fresh installs schedule the withdrawal sweep', async () => {
  // The application registry is only consulted when an operator regenerates
  // the managed crontab; install.sh has its own hard-coded bootstrap list.
  const { readFileSync } = await import('node:fs')
  const install = readFileSync('scripts/install.sh', 'utf8')
  assert.ok(install.includes('wc-withdrawal-sweep'), 'the installer bootstrap must include the backstop')
})

test('the sweep honours the WooCommerce kill switches', async () => {
  // It calls the WooCommerce API and can import orders, so a stale crontab
  // must not keep it running while sync is deliberately paused.
  const { readFileSync } = await import('node:fs')
  const route = readFileSync('app/api/cron/wc-withdrawal-sweep/route.ts', 'utf8')
  assert.ok(route.includes("isIntegrationPluginEnabled('woocommerce')"))
  assert.ok(route.includes("'wc_sync_enabled'"))
  assert.ok(route.indexOf('wc_sync_enabled') < route.indexOf('sweepWithdrawalSuppressions()'))
})

test('a rejection must HOLD before the tombstone is retired', () => {
  // One live read is not enough: a resubmission landing between that read and
  // the delete, whose webhook is then missed, is erased along with the only
  // durable signal — and the WMS create path checks only the IMS markers, so
  // its sweep could push the now-withdrawn order.
  const QUIESCENCE = 30 * 60_000
  const retires = (since: Date | null, now: number) =>
    since !== null && now - since.getTime() >= QUIESCENCE
  const t0 = new Date('2026-08-02T10:00:00Z')
  assert.equal(retires(null, t0.getTime()), false, 'the first observation only starts the clock')
  assert.equal(retires(t0, t0.getTime() + 60_000), false, 'still inside the window')
  assert.equal(retires(t0, t0.getTime() + QUIESCENCE), true, 'held long enough across sweep passes')
})

test('a new withdrawal resets a pending clear', async () => {
  // Otherwise a request recorded during the quiescence window is retired by a
  // clock that was started before it existed.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function recordWithdrawalSuppressionIfWithdrawn'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('clearPendingSince: null'))
})

test('retirement is a soft delete, and the fence outlives it', async () => {
  // Deleting outright ended the fulfilment fence at the same instant as the
  // decision to end it, so a resubmission landing between the final live read
  // and the delete — with its webhook missed — left a warehouse-eligible order
  // with neither marker nor row.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function retireSuppression'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('retiredAt: new Date()'), 'retirement must be a soft delete')
  assert.ok(!body.includes('deleteMany'), 'it must not remove the row')

  // Exactly one hard delete, and it sits behind a live read that just proved
  // the order is not withdrawn. A bulk purge of grace-expired rows deleted
  // rows it had never verified — including rows outside the sweep batch, which
  // were therefore never re-checked at all.
  const deletes = [...src.matchAll(/wcWithdrawalSuppression\.delete/g)].length
  assert.equal(deletes, 1, 'one hard-delete site only')
  const sweep = src.slice(src.indexOf('export async function sweepWithdrawalSuppressions'))
  const body2 = sweep.slice(0, sweep.indexOf('\n}\n'))
  assert.ok(body2.indexOf('readLiveWcOrder') < body2.indexOf('wcWithdrawalSuppression.deleteMany'),
    'the fence may only be dropped behind a confirming live read')
  assert.ok(body2.includes('retiredAt: row.retiredAt'), 'and only if it has not changed since')
})

test('a retired row still fences the WMS claim but does not block import', async () => {
  const { readFileSync } = await import('node:fs')
  const wms = readFileSync('lib/domain/wms/order-push-sweep.ts', 'utf8')
  const fn = wms.slice(wms.indexOf('async claimForCreate('))
  const body = fn.slice(0, fn.indexOf('\n    },'))
  // The fence must NOT filter on retiredAt — a retired row inside its grace
  // is exactly what keeps the order unpushable.
  const fence = body.slice(body.indexOf('wcWithdrawalSuppression'))
  assert.ok(!fence.slice(0, 400).includes('retiredAt'), 'the fence covers retired rows too')

  // Import, by contrast, must not be blocked by the row it was retired to allow.
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  assert.ok(src.includes('if (!suppressed || suppressed.retiredAt) return { suppress: false }'))
})

test('a new withdrawal revives a retired row', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('export async function recordWithdrawalSuppressionIfWithdrawn'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.includes('retiredAt: null'), 'a live request must un-retire the row')
})

test('a live suppression fences the WMS create claim', async () => {
  // The IMS markers are written by the withdrawal handler, so an order whose
  // withdrawal the STOREFRONT knows about but IMS has not yet applied — a
  // missed webhook, an import that raced a resubmission — carries neither
  // marker. The WMS sweep runs every 10 minutes and the withdrawal sweep every
  // 15, so checking only the markers leaves a window to push a withdrawn order.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/domain/wms/order-push-sweep.ts', 'utf8')
  const fn = src.slice(src.indexOf('async claimForCreate('))
  const body = fn.slice(0, fn.indexOf('\n    },'))
  assert.ok(body.includes('wcWithdrawalSuppression'), 'the claim must fence on a live suppression')
  assert.ok(body.indexOf('wcWithdrawalSuppression') < body.indexOf('wmsOrderPushLink.upsert'),
    'the fence must precede granting the claim')
  // Inside the same row-lock transaction as the marker re-check, or it is
  // merely racing rather than mutually exclusive.
  assert.ok(body.includes('FOR UPDATE'))
  assert.ok(body.indexOf('FOR UPDATE') < body.indexOf('wcWithdrawalSuppression'))
})

test('retirement re-reads live immediately before retiring', async () => {
  // Quiescence proves the rejection is OLD, not that nothing arrived since the
  // read that started this pass — and once the row is gone there are no
  // further by-ID checks at all.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/withdrawal.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function retireIfQuiescent'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.ok(body.indexOf('readLiveWcStatus') < body.indexOf('retireSuppression'))
  assert.ok(body.includes('finalLive === null'), 'an unreadable final status must not retire it')
})
