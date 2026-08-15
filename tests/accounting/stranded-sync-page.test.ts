import assert from 'node:assert/strict'
import test from 'node:test'

import { PermissionDeniedError } from '@/lib/auth/session-gates'
import type { ConnectorOrphanSummary } from '@/lib/domain/accounting/connector-orphans'
import { mountClientComponent } from '@/tests/fixtures/render-client-component'
import {
  RedirectError,
  callArgs,
  elementOf,
  installSyncPageMocks,
  propsOf,
  renderSyncPage,
  resetSyncPageState,
  state,
  strandedRow,
} from './sync-page-harness'

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the Integrations page, as BEHAVIOUR.
//
// A React Server Component is an async function that returns an element tree, so it can simply be
// awaited here with its dependencies module-mocked. That gives real evidence, which the structural
// AST guard this file replaces could not provide: that guard matched names and source order, so it
// stayed green against code that called hasPermission as a dead expression, hardcoded the gate, or
// passed constants to the decision functions.
//
// Four complementary observations are made of the result:
//   * the CALL LOG — which reads the page performed, in order, with which arguments. Without this
//     the mocks are all interchangeable and a rewired or re-limited read stays green.
//   * the ELEMENT TREE (walked through props.children) — which components the page constructed and
//     what it handed them. This is how "the dashboard is absent" is observed at all, and how the
//     22 reads are shown to reach the 26 dashboard props they claim to.
//   * the RENDERED MARKUP (react-dom/server, already a dependency of any Next app; no DOM, no new
//     package) — what the operator would actually read.
//   * the CONTROLS, PRESSED (round 4, finding 3). Markup shows that buttons exist; only invoking
//     their handlers shows what they DO. See "the cancel controls, actually used" below.
//
// The module fakes live in ./sync-page-harness, shared with sync-page-real-gates.test.ts — which
// renders the same page with the real getPaymentMethodCombos and its real permission gate.
// ---------------------------------------------------------------------------

installSyncPageMocks()

test.beforeEach(resetSyncPageState)

// ---------------------------------------------------------------------------
// The page boundary: `sync` is what this page IS.
// ---------------------------------------------------------------------------

test('an authenticated role without `sync` gets NO page at all, not a partial one', async () => {
  // FINDING 1 (round 3). Panelising the reads turned every rejection into "this panel is
  // unavailable", so a role without `sync` stopped being stopped: with a plugin enabled it fell
  // past the redirect, every read that demanded more than authentication degraded to a banner,
  // and the operator got a rendered Integrations page — accounting state, warnings and controls —
  // built entirely out of authorization denials. A denial is not an outage.
  state.role = 'FINANCE' // authenticated, holds `analytics`/`sales`/`purchasing`, NOT `sync`
  state.plugins = { woocommerce: true, xero: true }

  const { names, html } = await renderSyncPage()

  assert.deepEqual(names, ['SyncAccessDenied'], 'the access-denied state is the WHOLE page')
  assert.ok(!names.includes('SyncDashboard') && !names.includes('ConnectorOrphanBanner'))
  assert.deepEqual(state.redirects, [], 'a denial is not a redirect to somewhere friendlier')
  assert.deepEqual(
    state.calls.map((c) => c.name),
    ['requirePermission'],
    'the gate runs before EVERY read — plugin state, banners and the 22 dashboard reads included',
  )
  assert.match(html, /don&#x27;t have access to Integrations/)
})

test('the denial is EXPLAINED, not reported as an unexpected error with dead-end actions', async () => {
  // FINDING 2 (round 4). Throwing the denial handed it to app/(dashboard)/error.tsx, which does not
  // recognise authorization at all: the operator got "Something went wrong / an unexpected error
  // occurred" plus Go to Login and Try Again — and in production the boundary sees only a digest,
  // so it could not have told the cases apart even if it wanted to. Neither action can resolve a
  // stable role denial: the same role signs back in, and the retry re-runs the same gate.
  state.role = 'WAREHOUSE'
  state.plugins = { woocommerce: true }

  const { html } = await renderSyncPage()

  assert.match(html, /requires the .*sync.* permission/, 'it names what is missing')
  assert.match(html, /Signing in again or reloading will not change that/, 'and says the dead ends are dead')
  assert.match(html, /ask an administrator/, 'and what would actually resolve it')
  assert.ok(!/Try Again|Go to Login/.test(html), 'neither dead-end action is offered')
  // The one destination any authenticated role can reach — not /settings/system, which this role
  // may not be able to act on either.
  assert.match(html, /href="\/dashboard"/)
})

test('a bookmarked /sync with every plugin disabled is refused explicitly, not redirected away', async () => {
  // FINDING 2 (round 4), the other entry: before the page gate existed, a reader with no plugin
  // enabled was bounced to the plugin settings, which at least went somewhere. The gate replaced
  // that with a thrown denial — a crash screen for a bookmarked link. It must now state the reason,
  // and must still not perform a single read on the way.
  state.role = 'READONLY'
  state.plugins = {}

  const { names } = await renderSyncPage()

  assert.deepEqual(names, ['SyncAccessDenied'])
  assert.deepEqual(state.redirects, [], 'no tour of a page this role may not act on either')
  assert.deepEqual(state.calls.map((c) => c.name), ['requirePermission'])
})

test('every role without `sync` is refused, and the two that hold it are not', async () => {
  // Pinned against the real ROLE_PERMISSIONS matrix so a future grant/revoke shows up here.
  state.plugins = { woocommerce: true }

  for (const role of ['WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    state.role = role
    state.calls = []
    const { names } = await renderSyncPage()
    assert.deepEqual(names, ['SyncAccessDenied'], `${role} must be refused`)
    assert.deepEqual(callArgs('getStrandedAccountingSyncRows'), [], `${role} must cause no read`)
  }
  for (const role of ['ADMIN', 'MANAGER']) {
    state.role = role
    state.calls = []
    const { names } = await renderSyncPage()
    assert.ok(callArgs('getStrandedAccountingSyncRows').length === 1, `${role} must reach the page`)
    assert.ok(!names.includes('SyncAccessDenied'), `${role} must not be refused`)
  }
})

test('a role without `sync` causes NO stranded read at all', async () => {
  // The loader returns per-row detail — sync-log ids, referenced entity ids, external transaction
  // ids, raw connector error text. A role without `sync` must not merely fail to render it; the
  // read must never happen.
  state.role = 'WAREHOUSE'

  const { names } = await renderSyncPage()

  assert.deepEqual(names, ['SyncAccessDenied'])
  assert.deepEqual(callArgs('getStrandedAccountingSyncRows'), [], 'the unauthorised role must cause no read whatsoever')
  assert.deepEqual(state.redirects, [])
})

test('an unauthenticated session still redirects rather than being reported as a denial', async () => {
  // requirePermission → requireAuth redirects to /login (or /2fa, or the invalidated-session
  // path). That is framework control flow: it must survive the access-denied catch untouched and
  // must NOT be rendered as "you don't have access".
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  state.role = null
  state.plugins = { woocommerce: true }

  await assert.rejects(() => SyncPage(), (error: RedirectError) => error.digest.startsWith('NEXT_REDIRECT'))
})

// ---------------------------------------------------------------------------
// Denials raised BELOW the page gate are fatal too — a read may demand more than `sync`.
// ---------------------------------------------------------------------------

test('a permission denial inside a dashboard read fails the page, it does not degrade a panel', async () => {
  // A read whose gate is STRICTER than the page's is a wiring bug, and it is surfaced as one: not
  // as the access-denied state (the reader was entitled to this page) and not as "the integration
  // settings could not be loaded — reload this page", an instruction that can never succeed, on a
  // page still showing warnings and controls.
  //
  // This was not hypothetical: getPaymentMethodCombos required `settings.company`, which MANAGER
  // does not hold, so MANAGER passed the page gate and died here. Round 4 aligned that read on
  // `sync`; sync-page-real-gates.test.ts pins the alignment against the real action. The invariant
  // itself is what this test keeps, for the next read that disagrees.
  state.plugins = { woocommerce: true }
  state.reads.getAccountingAccounts = () => {
    throw new PermissionDeniedError('Forbidden: missing permission settings.company', 'settings.company')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(
    () => SyncPage(),
    (error: unknown) => error instanceof PermissionDeniedError && error.permission === 'settings.company',
  )
})

test('a denial that loses the race to an ordinary failure still takes the page down', async () => {
  // allSettled decides across ALL rejections: a denial must not be outvoted by whichever
  // ordinary error happened to reject first.
  state.plugins = { woocommerce: true }
  state.reads.getAccountingSyncLogs = () => { throw new Error('database is unreachable') }
  state.reads.getCurrencies = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    throw new PermissionDeniedError('Forbidden: missing permission settings.company', 'settings.company')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: unknown) => error instanceof PermissionDeniedError)
})

test('a permission denial from a BANNER read is fatal, not a silently missing banner', async () => {
  // panel() degrades availability failures. A denial routed through it would delete the warning
  // and leave the rest of the page standing — the operator sees a page that looks fine.
  state.plugins = { woocommerce: true }
  state.reads.getCrossConnectorOrphanSummary = () => {
    throw new PermissionDeniedError('Forbidden: missing permission sync', 'sync')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: unknown) => error instanceof PermissionDeniedError)
})

test('a permission denial from the stranded loader is fatal, not `strandedLoadFailed`', async () => {
  // "The list could not be loaded, reload to try again" is a lie when the answer is "you may not
  // see this list".
  state.plugins = { woocommerce: true }
  state.reads.getStrandedAccountingSyncRows = () => {
    throw new PermissionDeniedError('Forbidden: missing permission sync', 'sync')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: unknown) => error instanceof PermissionDeniedError)
})

// ---------------------------------------------------------------------------
// The redirect, and the state this feature exists for.
// ---------------------------------------------------------------------------

test('with every plugin disabled and nothing stranded, the page still redirects', async () => {
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')

  await assert.rejects(() => SyncPage(), /NEXT_REDIRECT/)
  assert.deepEqual(callArgs('getStrandedAccountingSyncRows'), [[50]], 'the rows are read BEFORE the redirect is decided')
  assert.deepEqual(state.redirects, ['/settings/system?tab=plugins'])
})

test('with every plugin disabled, stranded rows keep the page reachable and list themselves', async () => {
  // The state this feature exists for: the retired accounting connector was the last enabled
  // plugin, so every unresolved accounting row is stranded — and the only page that can show them
  // used to redirect away before looking.
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { names, html } = await renderSyncPage()

  assert.deepEqual(state.redirects, [], 'stranded rows must hold the page open')
  assert.ok(names.includes('ConnectorOrphanBanner'), 'the banner must be in the tree')
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
  assert.match(html, /SalesOrder:order-7/, 'the row is identified, not counted')
  assert.match(html, /HTTP 500 from QuickBooks/)
})

test('the stranded failure banner renders even when the neighbouring accounting-log read fails too', async () => {
  // The common causes of the loader failing — the database being unreachable, an
  // AccountingSyncLog read erroring — take the ORDINARY accounting-log read down with it. That
  // read used to be an uncaught await in a Promise.all a few lines later, so the whole server
  // component aborted and the operator got the error boundary instead of this branch's explicit
  // failure state, on the one page that could have recovered them.
  state.reads.getStrandedAccountingSyncRows = () => { throw new Error('database is unreachable') }
  state.reads.getAccountingSyncLogs = () => { throw new Error('database is unreachable') }

  const { names, html } = await renderSyncPage()

  assert.deepEqual(state.redirects, [], 'an unknown stranded state must not redirect away')
  assert.ok(names.includes('ConnectorOrphanBanner'))
  assert.match(html, /The list of stranded sync rows could not be loaded/)
  assert.match(html, /This does NOT mean there\s+are none/, '"we could not look" is not "there are none"')
  // The dashboard read failed with it, and says so rather than rendering as empty.
  assert.ok(!names.includes('SyncDashboard'), 'the dashboard panel is absent, not half-populated')
  assert.match(html, /could not be loaded, so they are not shown/)
})

test('a redirect thrown by the stranded loader is still a redirect, not a failed panel', async () => {
  // requireAuth inside the loader redirects an unverified-2FA or invalidated session. Catching
  // that as "the list failed to load" would strand the operator here instead of at the challenge.
  state.plugins = { woocommerce: true }
  state.reads.getStrandedAccountingSyncRows = () => { throw new RedirectError('/auth/2fa') }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: RedirectError) => error.digest.startsWith('NEXT_REDIRECT'))
})

test('a null orphan summary hides the cancel controls but not the stranded rows', async () => {
  // The aggregate count and the row list are separate panels. When the count is unavailable there
  // is no trustworthy total to act on, so the cancel controls go — but the rows, which are the
  // only view of work stranded on a retired connector, must stay.
  state.plugins = { woocommerce: true }
  state.reads.getCrossConnectorOrphanSummary = () => { throw new Error('count query failed') }
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow(), strandedRow({ id: 'log-2', referenceId: 'order-9' })], hasMore: false, total: 2 })

  const { names, html } = await renderSyncPage()

  assert.ok(names.includes('ConnectorOrphanBanner'))
  assert.match(html, /Showing all 2 stranded row\(s\), oldest first\./)
  assert.match(html, /SalesOrder:order-9/)
  assert.ok(!html.includes('<button'), 'no cancel control without a trustworthy total')
  assert.ok(!html.includes('accounting sync row(s) are queued'), 'no aggregate paragraph either')
})

test('a positive orphan summary renders the aggregate count AND the cancel controls', async () => {
  // FINDING 2 (round 3): the counterpart of the test above. Every other test in this file leaves
  // the summary null or failed, so deleting the count paragraph and both cancel controls outright
  // used to leave the whole file green — the "hides the cancel controls" assertion above passes
  // most easily when there are no cancel controls at all.
  //
  // What those controls DO is asserted below, in "the cancel controls, actually used": this test
  // is only about what is on the page.
  state.plugins = { woocommerce: true }
  const summary = orphanSummary()
  state.reads.getCrossConnectorOrphanSummary = () => summary
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { tree, html } = await renderSyncPage()

  assert.equal(propsOf(tree, 'ConnectorOrphanBanner')?.summary, summary, 'the summary reaches the banner by identity')
  // The aggregate paragraph, with the total and the "no connector is enabled" qualifier.
  assert.match(html, /3 accounting sync row\(s\) are queued for a connector that is no longer active/)
  assert.match(html, /\(no accounting connector is enabled\)/)
  // The per-connector breakdown, labelled rather than raw connector ids.
  assert.match(html, /QuickBooks<\/span>: 2 row\(s\)/)
  assert.match(html, /Xero<\/span>: 1 row\(s\)/)
  // The controls: one per group, plus the cancel-all that only appears above a single group.
  assert.equal(html.match(/Cancel these/g)?.length, 2, 'one cancel control per orphaned connector')
  assert.match(html, /Cancel all orphaned rows/)
  assert.equal(html.match(/<button/g)?.length, 3)
  // …and the row list is unaffected by the summary being present.
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
})

test('a truncated list says how many of how many — never a bare count', async () => {
  // The list is read-only: nothing here can clear a FAILED row (o3d-e2mz), so the oldest rows
  // never move and every newer stranded row is hidden behind them indefinitely. "3" would read as
  // "there are 3".
  state.plugins = { woocommerce: true }
  state.reads.getStrandedAccountingSyncRows = () => ({
    rows: [strandedRow({ id: 'a' }), strandedRow({ id: 'b' }), strandedRow({ id: 'c' })],
    hasMore: true,
    total: 137,
  })

  const { html } = await renderSyncPage()

  assert.match(html, /Showing the oldest 3 of 137 stranded row\(s\) — 134 more are not listed here\./)
  assert.match(html, /The hidden rows stay hidden until the ones listed here are resolved\./)
})

// ---------------------------------------------------------------------------
// The cancel controls, actually used.
//
// FINDING 3 (round 4): counting <button> elements and their labels proves only that something was
// rendered. Removing an onClick, passing the wrong connector, or wiring a per-connector button to
// the UNSCOPED cancel — which retires rows across EVERY inactive connector — all stayed green.
// These tests press the controls the PAGE built (the banner element is taken straight out of the
// page's tree, with the page's own props) and assert the argument each one sends.
// ---------------------------------------------------------------------------

function orphanSummary(): ConnectorOrphanSummary {
  return {
    activeConnector: null,
    orphanGroups: [{ connector: 'quickbooks', count: 2 }, { connector: 'xero', count: 1 }],
    totalOrphans: 3,
  }
}

async function mountBannerFromPage() {
  state.plugins = { woocommerce: true }
  state.reads.getCrossConnectorOrphanSummary = () => orphanSummary()
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { tree } = await renderSyncPage()
  const element = elementOf(tree, 'ConnectorOrphanBanner')
  assert.ok(element, 'the page must construct the banner')
  return mountClientComponent(element.type as (props: unknown) => unknown, element.props)
}

test('each per-connector control cancels THAT connector — never the unscoped operation', async () => {
  const banner = await mountBannerFromPage()
  const { controls } = banner.render()

  assert.deepEqual(
    controls.map((c) => c.label),
    ['Cancel these', 'Cancel these', 'Cancel all orphaned rows'],
    'three controls, and every one of them has a handler',
  )

  await banner.click(controls.find((c) => c.label === 'Cancel these' && c.scope.includes('QuickBooks')))
  assert.deepEqual(state.cancel.calls, [['quickbooks']], 'the QuickBooks control is scoped to QuickBooks')

  await banner.click(controls.find((c) => c.label === 'Cancel these' && c.scope.includes('Xero')))
  assert.deepEqual(
    state.cancel.calls,
    [['quickbooks'], ['xero']],
    'and the Xero control to Xero — the connector is the argument, not the label',
  )
})

test('Cancel all sends NO connector, which is what makes it the unscoped operation', async () => {
  // cancelOrphanedAccountingSyncRows(undefined) cancels every non-active connector's rows at once.
  // That is deliberate for this control and catastrophic for the per-connector ones above, so the
  // absence of the argument is asserted, not merely the presence of a call.
  const banner = await mountBannerFromPage()
  const { controls } = banner.render()

  await banner.click(controls.find((c) => c.label === 'Cancel all orphaned rows'))

  assert.deepEqual(state.cancel.calls, [[undefined]])
})

test('a successful cancel refreshes the page; a failed one explains itself and does not', async () => {
  const banner = await mountBannerFromPage()

  // Success: the server summary is the source of truth, so the banner re-reads it rather than
  // editing its own copy. Without the refresh the cancelled rows stay on screen indefinitely.
  await banner.click(banner.render().controls.find((c) => c.label === 'Cancel all orphaned rows'))
  assert.equal(state.refreshes, 1, 'a successful cancel re-reads the summary')
  assert.ok(!banner.render().html.includes('could not be cancelled'), 'and says nothing alarming')

  // Failure: the action fails closed (e.g. the connector is the active one, or no connector was
  // resolvable) and returns a reason. Swallowing it leaves a button that visibly does nothing.
  state.cancel.result = { success: false, cancelled: 0, error: 'Cannot cancel sync rows for the active connector.' }
  await banner.click(banner.render().controls.find((c) => c.label === 'Cancel all orphaned rows'))

  assert.equal(state.refreshes, 1, 'a failed cancel must NOT refresh — there is nothing new to read')
  assert.match(banner.render().html, /Cannot cancel sync rows for the active connector\./)
})

test('rows the cancel could not retire are reported, not silently left in the count', async () => {
  // o3d-sref: PROCESSING rows are left alone, so the orphan count does not fall to zero. A control
  // that appears to succeed while the warning stays put reads as broken.
  state.cancel.result = { success: true, cancelled: 4, inFlightNotCancelled: 2 }
  const banner = await mountBannerFromPage()

  await banner.click(banner.render().controls.find((c) => c.label === 'Cancel all orphaned rows'))

  assert.equal(state.refreshes, 1)
  assert.match(banner.render().html, /2 row\(s\) could not be cancelled/)
  assert.match(banner.render().html, /a request may have reached it and been lost/)
})

// ---------------------------------------------------------------------------
// Ordinary failures still degrade — the fatal split must not swallow everything.
// ---------------------------------------------------------------------------

test('a failed dashboard read degrades to a notice instead of taking the banners down', async () => {
  // Per-panel degradation, stated rather than implied: the dashboard is one panel because a
  // half-loaded one would show "no credentials" / "no sync activity" for reads that never
  // returned — the same lie (failure rendered as emptiness) the banner above refuses to tell.
  state.plugins = { woocommerce: true }
  state.reads.getAccountingSyncLogs = () => { throw new Error('database is unreachable') }
  state.reads.getStrandedAccountingSyncRows = () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { names, html } = await renderSyncPage()

  assert.ok(!names.includes('SyncDashboard'), 'the failed panel is absent')
  assert.match(html, /could not be loaded, so they are not shown/)
  assert.match(html, /This does NOT\s+mean nothing is configured/)
  assert.ok(names.includes('ConnectorOrphanBanner'), 'the other panels survive it')
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
})

test('a redirect thrown by any dashboard read still redirects, even alongside an ordinary failure', async () => {
  // Promise.all rejects with whichever rejection lands first, so an ordinary error could otherwise
  // mask a redirect thrown by a different read and demote an auth challenge to a degraded page.
  state.plugins = { woocommerce: true }
  // The ordinary failure is the FASTER of the two, so a first-rejection-wins page would degrade.
  state.reads.getAccountingSyncLogs = () => { throw new Error('database is unreachable') }
  state.reads.getCurrencies = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    throw new RedirectError('/auth/2fa')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: RedirectError) => error.digest === 'NEXT_REDIRECT;replace;/auth/2fa;307;')
})

test('the page hands the banner the resolver inputs it claims to — including the failure flag', async () => {
  // The element tree, not the source text: this is the data flow the AST guard asserted only by
  // name matching, and it is what makes the rendered wording above attributable to the page.
  state.plugins = { woocommerce: true }
  state.reads.getStrandedAccountingSyncRows = () => { throw new Error('database is unreachable') }

  const { tree } = await renderSyncPage()
  const props = propsOf(tree, 'ConnectorOrphanBanner')

  assert.ok(props, 'the banner is constructed')
  assert.equal(props.strandedLoadFailed, true, 'a failed read is passed as a failure')
  assert.equal(props.stranded, null, 'and NOT as an empty list')
  assert.equal(props.summary, null)
})

// ---------------------------------------------------------------------------
// The happy path, wired end to end.
// ---------------------------------------------------------------------------

test('every read is made with the arguments it claims, and every result reaches its dashboard prop', async () => {
  // FINDING 2 (round 3): with the dashboard stubbed and every mock returning an interchangeable
  // empty value, NO test observed the 22 reads or the 26 props they feed. Changing
  // getAccountingSyncLogs(50) to another limit, or swapping two same-typed props, stayed green.
  // Distinct sentinels + the ordered call log make each wire individually falsifiable.
  state.plugins = { woocommerce: true, shopify: true, xero: true, mintsoft: true }

  const s = {
    shoppingSettings: { sentinel: 'shoppingSettings' },
    shoppingTaxMappings: [{ sentinel: 'shoppingTaxMappings' }],
    shoppingStatusMappings: [{ sentinel: 'shoppingStatusMappings' }],
    shoppingLogs: [{ sentinel: 'shoppingLogs' }],
    shoppingCredentials: { sentinel: 'shoppingCredentials' },
    shopifySettings: { sentinel: 'shopifySettings' },
    shopifyCredentials: { sentinel: 'shopifyCredentials' },
    shopifyLogs: [{ sentinel: 'shopifyLogs' }],
    // Shaped: the page maps this to {id,name} for `taxRates` and passes it whole as `imsTaxRates`.
    taxRatesRaw: [{ id: 'tax-id', name: 'tax-name', sentinel: 'taxRatesRaw' }],
    accountingSettings: { sentinel: 'accountingSettings' },
    accountingStatus: { connected: true, tenantName: 'tenant-sentinel' },
    accountingConnectionTest: { sentinel: 'accountingConnectionTest' },
    accountingAccounts: [{ sentinel: 'accountingAccounts' }],
    accountingLogs: [{ sentinel: 'accountingLogs' }],
    paymentMethodCombos: [{ sentinel: 'paymentMethodCombos' }],
    paymentAccountMap: '{"sentinel":"paymentAccountMap"}',
    accountingReadiness: { sentinel: 'accountingReadiness' },
    // Shaped: the page maps this to {code,name} for `currencies`.
    currenciesRaw: [{ code: 'CUR', name: 'currency-name', sentinel: 'currenciesRaw' }],
    shoppingPaymentMethods: [{ sentinel: 'shoppingPaymentMethods' }],
    accountingBatchPreview: { sentinel: 'accountingBatchPreview' },
    accountingBatchHistory: [{ sentinel: 'accountingBatchHistory' }],
    wmsData: { sentinel: 'wmsData' },
    accountingTaxRates: [{ sentinel: 'accountingTaxRates' }],
  }

  state.reads.getShoppingSyncSettings = () => s.shoppingSettings
  state.reads.getShoppingTaxRateMappings = () => s.shoppingTaxMappings
  state.reads.getShoppingStatusMappings = () => s.shoppingStatusMappings
  state.reads.getShoppingSyncLogs = () => s.shoppingLogs
  state.reads.getShoppingConnectorCredentials = () => s.shoppingCredentials
  state.reads.getShopifySyncSettings = () => s.shopifySettings
  state.reads.getShopifyConnectorCredentials = () => s.shopifyCredentials
  state.reads.getShopifySyncLogs = () => s.shopifyLogs
  state.reads.getTaxRates = () => s.taxRatesRaw
  state.reads.getAccountingSettingsMasked = () => s.accountingSettings
  state.reads.getAccountingConnectionStatus = () => s.accountingStatus
  state.reads.getAccountingConnectionTestState = () => s.accountingConnectionTest
  state.reads.getAccountingAccounts = () => s.accountingAccounts
  state.reads.getAccountingSyncLogs = () => s.accountingLogs
  state.reads.getPaymentMethodCombos = () => s.paymentMethodCombos
  state.reads.getPaymentAccountMap = () => s.paymentAccountMap
  state.reads.getAccountingSyncReadiness = () => s.accountingReadiness
  state.reads.getCurrencies = () => s.currenciesRaw
  state.reads.getShoppingConnectorPaymentMethods = () => s.shoppingPaymentMethods
  state.reads.getAccountingBatchPreview = () => s.accountingBatchPreview
  state.reads.getAccountingBatchHistory = () => s.accountingBatchHistory
  state.reads.getWmsSyncDashboardData = () => s.wmsData
  state.reads.fetchAccountingTaxRates = () => s.accountingTaxRates

  const { tree, names } = await renderSyncPage()

  // --- what was read, in order, with what arguments -------------------------
  assert.deepEqual(state.calls, [
    { name: 'requirePermission', args: ['sync'] },
    { name: 'getIntegrationPluginState', args: [] },
    { name: 'getStrandedAccountingSyncRows', args: [50] },
    { name: 'getShoppingSyncSettings', args: [] },
    { name: 'getShoppingTaxRateMappings', args: [] },
    { name: 'getShoppingStatusMappings', args: [] },
    { name: 'getShoppingSyncLogs', args: [100] },
    { name: 'getShoppingConnectorCredentials', args: [] },
    { name: 'getShopifySyncSettings', args: [] },
    { name: 'getShopifyConnectorCredentials', args: [] },
    { name: 'getShopifySyncLogs', args: [100] },
    { name: 'getTaxRates', args: [] },
    { name: 'getAccountingSettingsMasked', args: [] },
    { name: 'getAccountingConnectionStatus', args: [] },
    { name: 'getAccountingConnectionTestState', args: [] },
    { name: 'getAccountingAccounts', args: [] },
    { name: 'getAccountingSyncLogs', args: [50] },
    { name: 'getPaymentMethodCombos', args: [] },
    { name: 'getPaymentAccountMap', args: [] },
    { name: 'getAccountingSyncReadiness', args: [] },
    { name: 'getCurrencies', args: [true] },
    { name: 'getShoppingConnectorPaymentMethods', args: [] },
    { name: 'getAccountingBatchPreview', args: [] },
    { name: 'getAccountingBatchHistory', args: [30] },
    // The WMS facade is handed the connector the page already resolved, so plugin state is read
    // once rather than again inside the facade.
    { name: 'getWmsSyncDashboardData', args: ['mintsoft'] },
    // Only reached because an accounting plugin is enabled AND the connection reports connected.
    { name: 'fetchAccountingTaxRates', args: [{ allowCache: true }] },
    { name: 'getCrossConnectorOrphanSummary', args: [] },
    { name: 'getFailedAccountingSyncSummary', args: [] },
    { name: 'getCurrentTaxRateDrift', args: [] },
    { name: 'getExceptionInboxSummary', args: [] },
  ])

  // --- where each result went ----------------------------------------------
  assert.ok(names.includes('SyncDashboard'), 'nothing failed, so the dashboard renders')
  const props = propsOf(tree, 'SyncDashboard')
  assert.ok(props)
  assert.deepEqual(Object.keys(props).sort(), [
    'accountingAccounts', 'accountingBatchHistory', 'accountingBatchPreview', 'accountingConnected',
    'accountingConnectionTest', 'accountingLogs', 'accountingReadiness', 'accountingSettings',
    'accountingTaxRates', 'accountingTenantName', 'currencies', 'imsTaxRates', 'paymentAccountMap',
    'paymentMethodCombos', 'pluginState', 'shopifyCredentials', 'shopifyLogs', 'shopifySettings',
    'shoppingCredentials', 'shoppingLogs', 'shoppingPaymentMethods', 'shoppingSettings',
    'shoppingStatusMappings', 'shoppingTaxMappings', 'taxRates', 'wmsData',
  ], 'the dashboard prop set is pinned: a new prop must be wired here deliberately')

  assert.equal(props.pluginState, state.plugins)
  assert.equal(props.shoppingSettings, s.shoppingSettings)
  assert.equal(props.shoppingTaxMappings, s.shoppingTaxMappings)
  assert.equal(props.shoppingStatusMappings, s.shoppingStatusMappings)
  assert.equal(props.shoppingLogs, s.shoppingLogs)
  assert.equal(props.shoppingCredentials, s.shoppingCredentials)
  assert.equal(props.shopifySettings, s.shopifySettings)
  assert.equal(props.shopifyCredentials, s.shopifyCredentials)
  assert.equal(props.shopifyLogs, s.shopifyLogs)
  assert.equal(props.imsTaxRates, s.taxRatesRaw)
  assert.deepEqual(props.taxRates, [{ id: 'tax-id', name: 'tax-name' }], 'projected to id+name, not passed whole')
  assert.equal(props.accountingSettings, s.accountingSettings)
  assert.equal(props.accountingConnected, true)
  assert.equal(props.accountingTenantName, 'tenant-sentinel')
  assert.equal(props.accountingConnectionTest, s.accountingConnectionTest)
  assert.equal(props.accountingAccounts, s.accountingAccounts)
  assert.equal(props.accountingLogs, s.accountingLogs)
  assert.equal(props.paymentMethodCombos, s.paymentMethodCombos)
  assert.equal(props.paymentAccountMap, s.paymentAccountMap)
  assert.equal(props.accountingReadiness, s.accountingReadiness)
  assert.deepEqual(props.currencies, [{ code: 'CUR', name: 'currency-name' }], 'projected to code+name')
  assert.equal(props.shoppingPaymentMethods, s.shoppingPaymentMethods)
  assert.equal(props.accountingBatchPreview, s.accountingBatchPreview)
  assert.equal(props.accountingBatchHistory, s.accountingBatchHistory)
  assert.equal(props.wmsData, s.wmsData)
  assert.equal(props.accountingTaxRates, s.accountingTaxRates)
})

test('the accounting tax-rate round trip is skipped unless a connector is enabled AND connected', async () => {
  // Its result is a dashboard prop, so "no accounting plugin" and "plugin enabled but not
  // connected" must both land on [] rather than on a live API call per render.
  state.plugins = { woocommerce: true, xero: true }
  state.reads.getAccountingConnectionStatus = () => ({ connected: false, tenantName: null })

  const notConnected = await renderSyncPage()
  assert.deepEqual(callArgs('fetchAccountingTaxRates'), [], 'not connected → no round trip')
  assert.deepEqual(propsOf(notConnected.tree, 'SyncDashboard')?.accountingTaxRates, [])

  state.calls = []
  state.plugins = { woocommerce: true }
  state.reads.getAccountingConnectionStatus = () => ({ connected: true, tenantName: 't' })

  const noAccountingPlugin = await renderSyncPage()
  assert.deepEqual(callArgs('fetchAccountingTaxRates'), [], 'no accounting plugin → no round trip')
  assert.deepEqual(propsOf(noAccountingPlugin.tree, 'SyncDashboard')?.accountingTaxRates, [])
})
