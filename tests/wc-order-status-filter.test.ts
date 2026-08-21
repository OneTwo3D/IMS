import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  isWcOrderAdmittedByStatus,
  parseWcSyncOrderStatuses,
  resolveWcPullStatuses,
  WC_DEFAULT_SYNC_ORDER_STATUSES,
} from '@/lib/connectors/woocommerce/order-status-filter'

// o3d-tj6v follow-up. `wc_sync_order_statuses` is advertised in the Settings UI
// as "Import order statuses", but it was interpreted in three places that
// disagreed: syncNewWcOrders parsed it inline, the initial import ignored it
// entirely for a hardcoded processing,pending,on-hold, and the Sync page parsed
// it a third way. These pin the one set of rules they now share.

const WDRAW = { submitted: 'pending-wdraw', approved: 'withdrawn' }

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('an unset, blank or malformed status setting falls back to the default', () => {
  for (const raw of [null, undefined, '', '   ', 'not json', '{"processing":true}', '["processing",7]']) {
    assert.deepEqual(
      parseWcSyncOrderStatuses(raw),
      [...WC_DEFAULT_SYNC_ORDER_STATUSES],
      `${JSON.stringify(raw)} is a malformed setting, not an expressed choice`,
    )
  }
})

test('an empty selection is honoured as "import nothing", not treated as unset', () => {
  // The old inline parse only fell back for a MISSING row, so `[]` survived to
  // `status=` on the WooCommerce query — where an empty status means ANY status.
  // Unticking every box therefore imported every order: the control did not
  // merely fail to act, it acted in reverse.
  assert.deepEqual(parseWcSyncOrderStatuses('[]'), [])
})

test('statuses are normalised, trimmed and de-duplicated', () => {
  assert.deepEqual(
    parseWcSyncOrderStatuses('["wc-processing","  ON-HOLD ","processing",""]'),
    ['processing', 'on-hold'],
  )
})

// ---------------------------------------------------------------------------
// Per-route resolution
// ---------------------------------------------------------------------------

test('the initial import fetches exactly the operator selection', () => {
  // It used to fetch a hardcoded processing,pending,on-hold. An operator who
  // unticked on-hold still got on-hold orders from the ONE import that runs on
  // every new installation.
  assert.deepEqual(resolveWcPullStatuses('initial', ['processing'], WDRAW), ['processing'])
  assert.deepEqual(
    resolveWcPullStatuses('initial', ['processing', 'pending', 'on-hold'], WDRAW),
    ['processing', 'pending', 'on-hold'],
  )
})

test('the initial import does NOT add the withdrawal statuses', () => {
  // Deliberate: it runs before live sync is unlocked, its own o3d-d82p guard
  // covers the page-snapshot race, and an unlinked withdrawal is skipped by
  // importWcOrderGuarded anyway — so fetching them would only add "skipped"
  // orders, which decideInitialImportOutcome counts as PROGRESS and could turn
  // a systemic failure into a false "complete" that unlocks live sync having
  // imported nothing.
  const statuses = resolveWcPullStatuses('initial', ['processing'], WDRAW)
  assert.equal(statuses.includes(WDRAW.submitted), false)
  assert.equal(statuses.includes(WDRAW.approved), false)
})

test('the poll sweep adds the withdrawal statuses but not completed', () => {
  assert.deepEqual(
    resolveWcPullStatuses('poll', ['processing'], WDRAW),
    ['processing', 'pending-wdraw', 'withdrawn'],
  )
})

test('the reconcile sweeps add completed as well as the withdrawal statuses', () => {
  for (const route of ['reconcile', 'manual_reconcile'] as const) {
    assert.deepEqual(
      resolveWcPullStatuses(route, ['processing'], WDRAW),
      ['processing', 'completed', 'pending-wdraw', 'withdrawn'],
      route,
    )
  }
})

test('completed is not duplicated when the operator already selected it', () => {
  assert.deepEqual(
    resolveWcPullStatuses('reconcile', ['processing', 'completed'], WDRAW),
    ['processing', 'completed', 'pending-wdraw', 'withdrawn'],
  )
})

test('an empty selection resolves to no statuses on every route, extras included', () => {
  // Adding `completed` or the withdrawal statuses to an empty selection would
  // resurrect exactly the orders the operator just excluded.
  for (const route of ['initial', 'poll', 'reconcile', 'manual_reconcile'] as const) {
    assert.deepEqual(resolveWcPullStatuses(route, [], WDRAW), [], route)
  }
})

test('a store with no withdrawal statuses configured gets no blank entries', () => {
  assert.deepEqual(
    resolveWcPullStatuses('poll', ['processing'], { submitted: '', approved: '' }),
    ['processing'],
  )
})

// ---------------------------------------------------------------------------
// The exemption has to be VISIBLE, not just decided
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..')
const SYNC_CLIENT = path.join(REPO_ROOT, 'app/(dashboard)/sync/sync-client.tsx')

test('the Sync page says the selection governs the webhook too, and what it does NOT gate', () => {
  // o3d-tj6v r3 REPLACES THE ASSERTION THAT USED TO LIVE HERE. It pinned the UI stating that the
  // webhook ignores the filter — true copy for a control that was advertised and unenforced, and
  // saying so out loud was never the same as honouring it. Now the selection reaches the webhook, so
  // the page must say that instead, together with the two limits that make it safe to believe:
  // an unselected order is skipped rather than lost, and an order IMS already has is never gated.
  // Keep in step with lib/connectors/woocommerce/webhooks.ts and docs/installation.md.
  const source = readFileSync(SYNC_CLIENT, 'utf8')
  const filterSection = source.slice(source.indexOf('Import order statuses'))

  assert.match(filterSection, /orders pushed by the order webhook, which are imported\s+only if they arrive in a selected status/)
  assert.match(filterSection, /if it later moves into a\s+selected status it is imported then/)
  assert.match(filterSection, /never stops updates to an order\s+you already have/)
  // r4/r5: and that ticking a status later recovers what was skipped, which is the half an operator
  // cannot otherwise discover — nothing in WooCommerce redelivers an order because IMS changed a
  // setting, and the delivery that was refused was ACKNOWLEDGED, so it never comes back on its own.
  // r5 makes the page state the mechanism that is actually a guarantee: each skipped order is
  // remembered BY ORDER NUMBER and re-checked on the fifteen-minute sweep, rather than depending on
  // a cursor rewind that only fires on a widening it can prove. Keep in step with
  // drainWcOrderAdmissionRefusals in sync/order-admission.ts.
  assert.match(filterSection, /remembered by its\s+WooCommerce order number and re-checked every 15 minutes/)
  assert.match(filterSection, /whether or not WooCommerce ever sends them again/)
  // ...and which fetch routes it governs, so the statement is still complete.
  assert.match(filterSection, /polling sweep/)
  assert.match(filterSection, /backup reconciliation/)
  // The old exemption copy must be gone, not merely contradicted further down the page.
  assert.doesNotMatch(filterSection, /does <strong>not<\/strong> apply to the order/)
})

// ---------------------------------------------------------------------------
// o3d-tj6v r3 — the webhook admission boundary
// ---------------------------------------------------------------------------

test('an admitted status lets an unseen pushed order in', () => {
  assert.equal(isWcOrderAdmittedByStatus('processing', ['processing', 'on-hold'], WDRAW), true)
})

test('a status the operator EXCLUDED does not let an unseen pushed order in', () => {
  // The whole point. Round 2 imported this order and told the operator so in the UI; the checkbox
  // said "Import order statuses" and pending orders imported anyway.
  assert.equal(isWcOrderAdmittedByStatus('pending', ['processing'], WDRAW), false)
})

test('admission normalises both sides, so a wc- prefix on either does not open or close the boundary', () => {
  assert.equal(isWcOrderAdmittedByStatus('wc-processing', ['processing'], WDRAW), true)
  assert.equal(isWcOrderAdmittedByStatus('processing', ['wc-processing'], WDRAW), true)
  assert.equal(isWcOrderAdmittedByStatus('WC-Processing', ['processing'], WDRAW), true)
})

test('withdrawal statuses are admitted whatever the selection', () => {
  // Same rule resolveWcPullStatuses applies to every live sweep (o3d-e1yb): a withdrawal that is
  // never seen means an order the customer asked to stop carries on to the warehouse.
  assert.equal(isWcOrderAdmittedByStatus(WDRAW.submitted, ['processing'], WDRAW), true)
  assert.equal(isWcOrderAdmittedByStatus(WDRAW.approved, ['processing'], WDRAW), true)
})

test('an EMPTY selection admits nothing at all, withdrawals included', () => {
  // Exactly what resolveWcPullStatuses does with an empty list — it short-circuits BEFORE the
  // withdrawal statuses are added. "Import nothing" has to mean the same thing on every route.
  assert.equal(isWcOrderAdmittedByStatus('processing', [], WDRAW), false)
  assert.equal(isWcOrderAdmittedByStatus(WDRAW.submitted, [], WDRAW), false)
  assert.deepEqual(resolveWcPullStatuses('poll', [], WDRAW), [])
})

test('a payload with no usable status is not admitted', () => {
  // Otherwise a malformed push is the one way past the boundary.
  for (const status of [null, undefined, '', '   ', 'wc-']) {
    assert.equal(isWcOrderAdmittedByStatus(status, ['processing'], WDRAW), false, `status ${JSON.stringify(status)}`)
  }
})

test('a store with no withdrawal statuses configured cannot be opened up by a blank one', () => {
  // getWithdrawalStatuses can yield '' for an unconfigured store. A blank must not match a blank
  // payload status, and normaliseWcOrderStatus('') is '' on both sides — hence the explicit
  // empty-status refusal above rather than relying on the comparison.
  assert.equal(isWcOrderAdmittedByStatus('', ['processing'], { submitted: '', approved: '' }), false)
  assert.equal(isWcOrderAdmittedByStatus('anything', ['processing'], { submitted: '', approved: '' }), false)
})

test('the Sync page describes the initial import by the selected statuses, not a hardcoded list', () => {
  const source = readFileSync(SYNC_CLIENT, 'utf8')

  assert.match(source, /using the statuses selected under Order/)
  // The old copy named the hardcoded list that the filter did not control.
  assert.doesNotMatch(source, /Import active WooCommerce orders \(processing, pending, on-hold\)/)
})
