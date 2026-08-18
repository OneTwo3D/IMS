import assert from 'node:assert/strict'
import test from 'node:test'

import { getPermissions } from '@/lib/permissions'
import {
  callArgs,
  installSyncPageMocks,
  propsOf,
  renderSyncPage,
  resetSyncPageState,
  state,
  strandedRow,
} from './sync-page-harness'

// ---------------------------------------------------------------------------
// o3d-osl8 round 4, finding 1 — the page's gate and its READS' gates, checked against each other.
//
// stranded-sync-page.test.ts mocks all 22 dashboard reads, which is what makes the page's own
// behaviour observable — and is exactly why it could not have caught this: it replaced
// getPaymentMethodCombos with a stub that authorises nobody, so "MANAGER reaches the page" was
// true of the double and false of the product. MANAGER holds `sync` and not `settings.company`;
// getPaymentMethodCombos required `settings.company`; the page treats a denial from any read as
// fatal. So MANAGER passed the page gate and then died on a mandatory read — including in the
// every-plugin-disabled + rows-stranded state this whole feature exists for, where this page is
// the only view of those rows.
//
// Here the real `@/app/actions/accounting` runs, with only the database beneath it faked, so its
// real requirePermission decides. Any future read re-gated above `sync` should get the same
// treatment rather than a stub.
// ---------------------------------------------------------------------------

installSyncPageMocks({ realPaymentMethodCombos: true })

test.beforeEach(() => {
  resetSyncPageState()
  state.salesOrderRows = [
    { paymentMethod: 'stripe', currency: 'GBP' },
    { paymentMethod: 'paypal', currency: 'EUR' },
    // Null methods are filtered out by the action itself.
    { paymentMethod: null, currency: 'USD' },
  ]
})

/** The premise of this file: if MANAGER ever gains `settings.company`, it stops proving anything. */
test('MANAGER holds `sync` and NOT `settings.company` — the mismatch this file exists for', () => {
  const manager = getPermissions('MANAGER')
  assert.ok(manager.has('sync'))
  assert.ok(!manager.has('settings.company'))
  // ADMIN holds both, which is why the mismatch was invisible in every ADMIN-shaped test.
  assert.ok(getPermissions('ADMIN').has('settings.company'))
})

test('MANAGER reaches the stranded rows with every plugin disabled — through the REAL combos gate', async () => {
  // The exact state this branch exists to serve: no integration plugin enabled, rows stranded on a
  // retired accounting connector, and the only page that can show them.
  state.role = 'MANAGER'
  state.plugins = {}
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { names, html } = await renderSyncPage()

  assert.ok(!names.includes('SyncAccessDenied'), 'MANAGER is entitled to this page')
  assert.deepEqual(state.redirects, [], 'stranded rows hold the page open')
  assert.ok(names.includes('ConnectorOrphanBanner'))
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
  assert.match(html, /SalesOrder:order-7/)
  assert.ok(names.includes('SyncDashboard'), 'and NO read failed, so the dashboard is there too')

  // The read really happened, and really went through a gate.
  assert.deepEqual(callArgs('db.salesOrder.findMany').length, 1, 'the real action queried, it was not stubbed')
  assert.deepEqual(
    state.calls.filter((c) => c.name === 'requirePermission').map((c) => c.args),
    [['sync'], ['sync']],
    'the page gate and the combos gate ask for the SAME permission',
  )
})

test('the real combos read returns its rows to the dashboard for MANAGER', async () => {
  // Not merely "it did not throw": the value has to arrive, or a future fix that swallows the
  // denial and passes [] would look identical here. [] is indistinguishable from "no order has
  // ever carried a payment method", which is the failure-as-emptiness lie this page refuses.
  state.role = 'MANAGER'
  state.plugins = { woocommerce: true }

  const { tree } = await renderSyncPage()

  assert.deepEqual(propsOf(tree, 'SyncDashboard')?.paymentMethodCombos, [
    { paymentMethod: 'stripe', currency: 'GBP' },
    { paymentMethod: 'paypal', currency: 'EUR' },
  ])
})

test('ADMIN is unaffected by the re-gate', async () => {
  state.role = 'ADMIN'
  state.plugins = { woocommerce: true }

  const { names } = await renderSyncPage()

  assert.ok(names.includes('SyncDashboard'))
  assert.equal(callArgs('db.salesOrder.findMany').length, 1)
})

test('a role without `sync` never reaches the real combos read', async () => {
  // The gate moved DOWN to `sync`, so it must still be a gate: FINANCE holds neither `sync` nor
  // `settings.company` and must be refused at the page boundary, with no query behind it.
  state.role = 'FINANCE'
  state.plugins = { woocommerce: true }

  const { names } = await renderSyncPage()

  assert.deepEqual(names, ['SyncAccessDenied'])
  assert.deepEqual(callArgs('db.salesOrder.findMany'), [], 'no sales-order query for an unentitled role')
})
