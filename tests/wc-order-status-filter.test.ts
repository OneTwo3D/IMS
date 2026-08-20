import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
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

test('the Sync page tells the operator that the webhook ignores the status filter', () => {
  // Deciding a webhook should not honour the filter is a legitimate answer only
  // if the UI says so — an operator reading "Import order statuses" will not
  // expect a webhook to bypass it, and a control that silently does less than
  // it claims is worse than an absent one. Keep this in step with the comment
  // in lib/connectors/woocommerce/webhooks.ts.
  const source = readFileSync(SYNC_CLIENT, 'utf8')
  const filterSection = source.slice(source.indexOf('Import order statuses'))

  assert.match(filterSection, /does <strong>not<\/strong> apply to the order\s+webhook/)
  assert.match(filterSection, /whatever its status/)
  // ...and which routes it DOES govern, so the statement is complete.
  assert.match(filterSection, /polling sweep/)
  assert.match(filterSection, /reconciliation/)
})

test('the Sync page describes the initial import by the selected statuses, not a hardcoded list', () => {
  const source = readFileSync(SYNC_CLIENT, 'utf8')

  assert.match(source, /using the statuses selected under Order/)
  // The old copy named the hardcoded list that the filter did not control.
  assert.doesNotMatch(source, /Import active WooCommerce orders \(processing, pending, on-hold\)/)
})
