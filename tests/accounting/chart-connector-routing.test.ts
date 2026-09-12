import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 — ONE CONNECTOR'S ROW MUST NOT CARRY ANOTHER CONNECTOR'S ACCOUNT CODES.
 *
 * THE DEFECT. `getAccountingSettings()` resolves the active accounting connector internally and
 * returns THAT connector's chart of accounts. An unpinned enqueue then built its whole payload out of
 * those codes and called `queueAccountingSync` with no connector at all, which resolved the active
 * connector AGAIN. Two independent reads of one question, with a numbering read, a tax-rate lookup and
 * a full line map in between: a switch committing in that window wrote connector B's row carrying
 * connector A's `salesAccount` / `shippingAccount` / `discountAccount`. The document then posts to
 * accounts that mean something else in the books it landed in, or is rejected there — and the row is
 * durable and claimable either way.
 *
 * WHY THE o3d-i0o6 r8 FENCE DOES NOT COVER IT, AND WHY NO LOCK IS ADDED HERE. That fence is for PINNED
 * enqueues — callers that PROVED a debit stands in particular books — and it is a transactional
 * advisory lock plus `FOR UPDATE` on the plugin rows, held to the inserting commit. Taking it for every
 * enqueue would serialise invoicing, shipment confirmation and every journal against each other and
 * against every settings save, which is precisely the decision PR #679 took and this must not reopen.
 * It is also not needed: the defect is a SECOND RESOLUTION, not an unlocked window, and deleting the
 * second resolution closes it outright. `chartConnector` is the connector the CODES came from, and the
 * facade ROUTES by it — so the row's connector and the payload's codes come from one read and cannot
 * disagree however long the window is or however many switches commit inside it. That property is
 * structural and costs no lock.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. THE RIG CAN FIND THE DEFECT. The first test drives the unchartered enqueue through the exact
 *      production interleaving and asserts the mis-attributed row — connector B, codes from A. Without
 *      it, every "nothing was written" assertion below could be passing for the wrong reason.
 *   2. A chartered enqueue in that same state writes NOTHING and answers `refused` (never
 *      `not-configured` — the posting is still owed), naming the chart's connector.
 *   3. It is not merely "always refuse": with the chart still active the row IS written, and written
 *      through the CHART'S queue.
 *   4. A `null` chart — no connector was on when the codes were read, so they are the empty-string
 *      defaults — answers `not-configured` and writes nothing even though a connector has since come on.
 *   5. A chart and a PIN that name different ledgers are refused rather than reconciled in either
 *      direction.
 *   6. THE REFUSAL IS NOT SILENTLY SWALLOWED. Most of the sites this closes ignore the enqueue's return
 *      value entirely, so the record has to come from the facade: a WARNING activity naming the type,
 *      the reference, the chart and the fact that the posting is still outstanding.
 *   7. And the in-transaction enqueue takes the same parameter with the same meaning, because two
 *      copies of this decision is what o3d-d0pd's three copies of the already-present check became.
 *
 * WHAT IT DOES NOT PROVE. That a switch committing between this pooled check and the connector queue's
 * INSERT is prevented — it is not, deliberately: closing that window is what costs the global lock.
 * What is closed there is the thing this issue is about, because the row is then written under the
 * chart's own connector: correct codes in correct books, on a ledger the manual sync can still drain.
 */

// --------------------------------------------------------------------------------------------
// The plugin selection, and the two charts
// --------------------------------------------------------------------------------------------

/** Which accounting plugins are on. Mutated MID-TEST to model the switch committing. */
let enabledPlugins: string[] = ['xero']

/**
 * How many plugin-selection reads the facade has made, and a switch that commits AFTER a given number
 * of them.
 *
 * THIS IS THE FIXTURE FOR THE OTHER HALF OF THE FIX, and without it that half is untestable. Refusing
 * when the chart has been retired is one thing; the thing that makes the refusal BINDING is that the
 * row is then ROUTED BY THE CHART rather than by a second read of the selection. Those two reads are
 * microseconds apart in a double and would always agree, so a rig that only mutates `enabledPlugins`
 * between statements cannot tell "routed by the chart" from "resolved again and happened to match".
 * Flipping the selection BETWEEN READS is exactly the production window — the unfixed facade asked
 * twice — and it is the only way to see the difference.
 */
let selectionReads = 0
let flipToQuickBooksAfterReads: number | null = null

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => {
      const answer = enabledPlugins.includes(id)
      selectionReads++
      if (flipToQuickBooksAfterReads !== null && selectionReads >= flipToQuickBooksAfterReads) {
        enabledPlugins = ['quickbooks']
      }
      return answer
    },
  },
})

/** Xero's chart. Every code is distinguishable from QuickBooks's, which is the whole point. */
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sync_sales_invoice: 'submitted',
      xero_sync_inventory_adjustment: 'submitted',
      xero_sales_account: 'X-SALES',
      xero_shipping_account: 'X-SHIP',
      xero_discount_account: 'X-DISC',
      xero_cogs_account: 'X-COGS',
      xero_inventory_revaluation_account: '',
      xero_inventory_account: 'X-INV',
      xero_allocated_inventory_account: 'X-ALLOC',
      xero_unearned_revenue_account: 'X-UNEARNED',
      xero_transit_account: 'X-TRANSIT',
      xero_accounts_receivable_account: 'X-AR',
      xero_accounts_payable_account: 'X-AP',
      xero_realised_fx_gain_loss_account: 'X-RFX',
      xero_unrealised_fx_gain_loss_account: 'X-UFX',
      xero_manufacturing_overhead_account: 'X-MOH',
    }),
  },
})

mock.module('@/lib/connectors/quickbooks/settings', {
  namedExports: {
    getQuickBooksSettings: async () => ({
      quickbooks_sync_enabled: 'true',
      quickbooks_sync_sales_invoice: 'submitted',
      quickbooks_sync_inventory_adjustment: 'submitted',
      quickbooks_sales_account: 'Q-SALES',
      quickbooks_shipping_account: 'Q-SHIP',
      quickbooks_discount_account: 'Q-DISC',
      quickbooks_cogs_account: 'Q-COGS',
      quickbooks_inventory_account: 'Q-INV',
      quickbooks_allocated_inventory_account: 'Q-ALLOC',
      quickbooks_unearned_revenue_account: 'Q-UNEARNED',
      quickbooks_transit_account: 'Q-TRANSIT',
      quickbooks_accounts_receivable_account: 'Q-AR',
      quickbooks_accounts_payable_account: 'Q-AP',
      quickbooks_realised_fx_gain_loss_account: 'Q-RFX',
      quickbooks_unrealised_fx_gain_loss_account: 'Q-UFX',
      quickbooks_manufacturing_overhead_account: 'Q-MOH',
    }),
  },
})

// --------------------------------------------------------------------------------------------
// The queues, the activity log, and the transaction double
// --------------------------------------------------------------------------------------------

/** Rows the facade routed, with the queue they went to and the codes they carried. */
const routed: Array<{ queue: 'xero' | 'quickbooks'; type: string; salesAccount: unknown }> = []

function recordRouted(queue: 'xero' | 'quickbooks') {
  return async (params: { type: string; payload: Record<string, unknown> }) => {
    const lines = params.payload.lines as Array<{ accountCode?: unknown }> | undefined
    routed.push({ queue, type: params.type, salesAccount: lines?.[0]?.accountCode })
    return { queued: true }
  }
}

mock.module('@/lib/connectors/xero/queue', {
  namedExports: { queueXeroSync: recordRouted('xero') },
})
mock.module('@/lib/connectors/quickbooks/queue', {
  namedExports: { queueQuickBooksSync: recordRouted('quickbooks') },
})

/** Activity records written by the facade. */
const activity: Array<{ action: string; description: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: { action: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push({ action: params.action, description: params.description, metadata: params.metadata })
    },
  },
})

/**
 * The in-transaction enqueue's order-scope assertion. `none` so a refusal below is attributable to the
 * chart check and not to the o3d-3zgy order-lock guard.
 */
mock.module('@/lib/domain/accounting/enqueue-order-guard', {
  namedExports: {
    resolveAccountingEnqueueOrderScope: async () => ({ scope: 'none' as const }),
    lockOrderForAccountingEnqueue: async () => false,
    findStaleOrderLevelDiscount: async () => null,
    logStaleOrderDiscountEnqueue: async () => undefined,
  },
})
mock.module('@/lib/connectors/accounting-id-provenance', {
  namedExports: { activeAccountingIdProvenance: async () => ({}) },
})
mock.module('@/lib/connectors/accounting-connection-provenance', {
  namedExports: {
    stampAccountingPayloadConnection: (payload: Record<string, unknown>) => payload,
    mintAccountingConnectionProvenanceColumn: () => null,
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { mirrorAccountingSyncLogToEvent: async () => undefined },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})
mock.module('@/lib/domain/accounting/followup-scope-lock', {
  namedExports: { lockFollowUpScope: async () => undefined },
})

/** Rows the IN-TRANSACTION enqueue inserted, with the connector each was written under. */
const insertedInTx: Array<{ connector: string; type: string; salesAccount: unknown }> = []

function transactionDouble() {
  return {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    accountingSyncLog: {
      findMany: async () => [],
      create: async ({ data }: { data: { connector: string; type: string; payload: Record<string, unknown> } }) => {
        const lines = data.payload.lines as Array<{ accountCode?: unknown }> | undefined
        insertedInTx.push({ connector: data.connector, type: data.type, salesAccount: lines?.[0]?.accountCode })
        return { id: `log-${insertedInTx.length}`, ...data }
      },
    },
    activityLog: { create: async () => ({ id: 'activity-1' }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionDouble()),
  }
}

/** The core settings table `getAccountingSettingsFor` reads its connector-agnostic values from. */
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      accountingSyncLog: { findMany: async () => [] },
      accountingToken: { findFirst: async () => null },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionDouble()),
    },
  },
})

mock.module('@/lib/db/savepoint', {
  namedExports: { withSavepoint: async <T>(_tx: unknown, fn: () => Promise<T>): Promise<T> => fn() },
})

function reset(selection: string[]): void {
  enabledPlugins = selection
  selectionReads = 0
  flipToQuickBooksAfterReads = null
  routed.length = 0
  insertedInTx.length = 0
  activity.length = 0
}

/** A sales invoice whose one line carries whatever the chart said `salesAccount` is. */
function salesInvoiceRequest(salesAccount: string) {
  return {
    type: 'SALES_INVOICE' as const,
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: salesAccount }] },
  }
}

// --------------------------------------------------------------------------------------------
// 1. THE RIG CAN FIND THE DEFECT
// --------------------------------------------------------------------------------------------

test('[o3d-j625] THE RIG CAN SEE THE DEFECT: a QuickBooks row carrying Xero’s account codes is observable through this fixture', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')

  // The chart read. `getAccountingSettings` resolved the active connector for itself and answered with
  // XERO's codes.
  const settings = await getAccountingSettings()
  assert.equal(settings.salesAccount, 'X-SALES', 'precondition: the chart read resolved Xero')
  assert.equal(settings.connector, 'xero', 'precondition: and the chart says so')

  // THE SWITCH COMMITS, somewhere in the payload build — the numbering read, the tax-rate lookup, the
  // line map. Nothing in the unpinned path serialises against it and nothing is meant to.
  enabledPlugins = ['quickbooks']

  // o3d-j625 r2 — WHY THIS CONTROL CHANGED SHAPE, AND WHAT IT STILL ESTABLISHES.
  //
  // r1's control reproduced the defect by OMITTING `chartConnector`, because omitting it meant "resolve
  // the connector again". As of r2 the parameter is required and an omission is REFUSED at runtime too
  // (see refuseUnattributableChart), so that state no longer produces a row at all — the test below
  // pins that. What this control still has to establish is that the mis-attributed row is OBSERVABLE
  // through this fixture: without it, every "nothing was written" assertion in this file could be
  // passing because the fixture cannot write anything.
  //
  // So it is produced the only way left: a caller that NAMES A CHART THAT IS NOT ITS OWN. The payload's
  // one account code is Xero's `X-SALES`, the call claims QuickBooks, QuickBooks is active — and the
  // facade dutifully writes a QuickBooks row carrying a Xero account code. That is exactly the row the
  // defect produced, and it is a reminder of what this mechanism does NOT prove: it proves every
  // enqueue is ATTRIBUTED, never that the attribution is TRUE. The truth of each attribution is
  // established per site by the SITE tests at the foot of
  // tests/accounting/chart-connector-call-sites.test.ts.
  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: 'quickbooks',
  })

  // The mis-attribution, in one assertion: the row is QuickBooks's, the code on it is Xero's.
  assert.equal(outcome.queued, true)
  assert.equal(routed.length, 1)
  assert.equal(routed[0].queue, 'quickbooks', 'the row is written under the connector the call NAMED')
  assert.equal(routed[0].salesAccount, 'X-SALES', 'while its account code came from Xero’s chart')
})

test('[o3d-j625 r2] an UNCHARTERED enqueue — reachable only by a cast now — is REFUSED, not resolved again', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  assert.equal(settings.connector, 'xero', 'precondition: the chart read resolved Xero')
  enabledPlugins = ['quickbooks']

  // THE r1 BEHAVIOUR, ASSERTED AWAY. r1 returned `null` from the chart guard for an absent chart and
  // carried on to `params.connector ?? params.chartConnector ?? await getActiveAccountingConnectorId()`
  // — the second resolution, which wrote the row above. The cast is what a JS caller, an `as never` in
  // a test, or a future refactor that loosened the type would look like, and none of them may get the
  // old behaviour back.
  const outcome = await queueAccountingSync(
    salesInvoiceRequest(settings.salesAccount) as unknown as Parameters<typeof queueAccountingSync>[0],
  )

  assert.equal(routed.length, 0, 'NOTHING may be written for a payload whose chart nobody named')
  assert.equal(outcome.queued, false)
  assert.equal(
    outcome.reason,
    'refused',
    'and the posting is OWED — `not-configured` is the one no-op an obligation ledger may settle with, '
    + 'and nothing here established that no counterpart will ever exist',
  )
  assert.equal(outcome.connector, null, 'no connector can be named, because none was')
})

// --------------------------------------------------------------------------------------------
// 2-6. THE FACADE, CHARTERED
// --------------------------------------------------------------------------------------------

test('[o3d-j625] a CHARTERED enqueue writes nothing when the chart’s connector has been retired, and says the posting is still owed', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')

  const settings = await getAccountingSettings()
  assert.equal(settings.connector, 'xero', 'precondition: the chart is Xero’s')
  enabledPlugins = ['quickbooks']

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(routed.length, 0, 'NOTHING may be written: neither ledger has a row that describes itself')
  assert.equal(outcome.queued, false)
  assert.equal(
    outcome.reason,
    'refused',
    'REFUSED, never not-configured: not-configured is the one no-op the refund obligation ledger may '
    + 'settle an obligation with, and this posting is still owed',
  )
  assert.equal(outcome.connector, 'xero', 'the answer names the chart it was given, not what is active now')
})

test('[o3d-j625] it is not "always refuse": with the chart still active the row IS written, and written through the CHART’S queue', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(outcome.queued, true)
  assert.equal(routed.length, 1)
  assert.equal(routed[0].queue, 'xero')
  assert.equal(routed[0].salesAccount, 'X-SALES', 'the codes and the queue are the same connector’s')
})

test('[o3d-j625] the QuickBooks chart routes to the QuickBooks queue — the rule is about agreement, not about Xero', async () => {
  reset(['quickbooks'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  assert.equal(settings.salesAccount, 'Q-SALES')

  await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(routed.length, 1)
  assert.equal(routed[0].queue, 'quickbooks')
  assert.equal(routed[0].salesAccount, 'Q-SALES')
})

test('[o3d-j625] a chart read while NO connector was on writes nothing, even though one has since come on', async () => {
  reset([])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')

  const settings = await getAccountingSettings()
  assert.equal(settings.connector, null, 'precondition: nothing was switched on')
  assert.equal(settings.salesAccount, '', 'precondition: so the account codes are the empty defaults')

  // A connector is switched ON in the window. Unchartered, this is the mirror-image of the first test:
  // a real row carrying NO account codes at all.
  enabledPlugins = ['xero']

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(routed.length, 0, 'a document with no account codes must not be queued to a live ledger')
  assert.equal(outcome.queued, false)
  assert.equal(
    outcome.reason,
    'not-configured',
    'a DECISION, not a refusal: when the chart was read nothing was going to post, which is exactly '
    + 'what an unpinned enqueue has always answered in that state',
  )
  assert.equal(outcome.connector, null)
})

test('[o3d-j625] a chart and a PIN that name different ledgers are refused, not reconciled', async () => {
  reset(['xero'])
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest('X-SALES'),
    // The proof says these pounds belong in Xero's books; the payload is written in QuickBooks's
    // account numbers. Honouring either one writes the other one's mistake.
    connector: 'xero',
    chartConnector: 'quickbooks',
  })

  assert.equal(routed.length, 0)
  assert.equal(outcome.queued, false)
  assert.equal(outcome.reason, 'refused')
  assert.equal(outcome.connector, 'xero', 'the pin is what the caller is owed an answer about')
})

test('[o3d-j625] the refusal is RECORDED, because almost every site it protects ignores the return value', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  const refusals = activity.filter((entry) => entry.action === 'accounting_enqueue_refused_retired_chart')
  assert.equal(refusals.length, 1, `the refusal must leave a record. Activity: ${JSON.stringify(activity)}`)
  assert.match(refusals[0].description, /NOTHING WAS QUEUED/)
  assert.match(refusals[0].description, /still OUTSTANDING/)
  assert.match(refusals[0].description, /SALES_INVOICE for SalesOrder order-1/)
  assert.equal(refusals[0].metadata?.chartConnector, 'xero')

  // o3d-j625 r2 (Codex MEDIUM 2) — AND IT NAMES THE CONNECTOR IT WAS REFUSED IN FAVOUR OF.
  //
  // r1 recorded only the chart. So the record said "built from Xero's chart, and Xero is no longer the
  // active connector" and could not say what IS active — which is the half that decides what an
  // operator does next (switch the selection back, or raise the posting in the other books). The
  // reviewer's note is sharper than untidiness: no application consumer reads this action, the generic
  // Activity page is the only reader, so whatever is not IN the record is not available anywhere.
  assert.equal(
    refusals[0].metadata?.activeConnector,
    'quickbooks',
    'the refusal must name the connector that is active NOW, not only the retired chart',
  )
  assert.match(
    refusals[0].description,
    /active accounting connector is now quickbooks/,
    `the description must name both ends of the switch. Got: ${refusals[0].description}`,
  )
})

test('[o3d-j625 r2] and when NOTHING is active, the refusal says that rather than naming a connector', async () => {
  // The other end of MEDIUM 2: `activeConnector` is nullable, and a record whose only statement about
  // it is an omitted field is indistinguishable from r1's record. `null` in the metadata and a sentence
  // that reads as English in the description.
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = []

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(outcome.reason, 'refused', 'the posting is owed: the chart was real, the ledger is gone')
  const refusals = activity.filter((entry) => entry.action === 'accounting_enqueue_refused_retired_chart')
  assert.equal(refusals.length, 1)
  assert.ok(
    'activeConnector' in (refusals[0].metadata ?? {}),
    'the field must be PRESENT and null, not absent — absent is what r1 wrote',
  )
  assert.equal(refusals[0].metadata?.activeConnector, null)
  assert.match(refusals[0].description, /no accounting connector at all/)
})

test('[o3d-j625] a chartered enqueue reads the plugin selection ONCE — there is no second resolution left to disagree', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  // Count only the reads the ENQUEUE makes, not the chart read's own.
  selectionReads = 0
  await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(routed.length, 1)
  assert.equal(
    selectionReads,
    1,
    'exactly one read: the check that the chart is still being serviced. A SECOND read would be the '
    + `defect — the row resolved independently of the codes. Reads: ${selectionReads}`,
  )
})

test('[o3d-j625] the row follows the CHART even when the selection moves between the check and the write', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  // THE WINDOW BETWEEN THE FACADE'S TWO READS, which is where the unfixed code lost the row: the
  // first read says Xero (so any "is the chart still serviced" check passes), and the switch to
  // QuickBooks commits before the second. There is no second read to see it any more.
  selectionReads = 0
  flipToQuickBooksAfterReads = 1

  const outcome = await queueAccountingSync({
    ...salesInvoiceRequest(settings.salesAccount),
    chartConnector: settings.connector,
  })

  assert.equal(outcome.queued, true)
  assert.equal(routed.length, 1)
  assert.equal(
    routed[0].queue,
    'xero',
    'the row is routed by the CHART, not by a resolution taken after it. Routing by a second read '
    + 'would put this row in QuickBooks carrying X-SALES, which is the whole defect.',
  )
  assert.equal(routed[0].salesAccount, 'X-SALES')
  assert.equal(outcome.connector, 'xero', 'and the caller is told which books it went to')
})

// --------------------------------------------------------------------------------------------
// 7. THE IN-TRANSACTION ENQUEUE TAKES THE SAME PARAMETER
// --------------------------------------------------------------------------------------------

const TX_REQUEST = {
  type: 'INVENTORY_ADJUSTMENT' as const,
  referenceType: 'StockMovement',
  referenceId: 'movement-1',
  unlockedOrderScopeReason: 'test harness: the order guard is doubled to a non-order scope',
}

test('[o3d-j625] the in-transaction rig can see the mis-attributed row too', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  // The same control, and the same reason for its shape, as the facade one above: the row that must be
  // OBSERVABLE for the refusal assertions below to mean anything — a QuickBooks row carrying Xero's
  // `X-INV`. Produced by naming a chart that is not this payload's.
  const control = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: 'quickbooks',
  })

  assert.equal(control, true)
  assert.equal(insertedInTx.length, 1)
  assert.equal(insertedInTx[0].connector, 'quickbooks', 'the row goes to the connector the call NAMED')
  assert.equal(insertedInTx[0].salesAccount, 'X-INV', 'carrying Xero’s inventory account')
})

test('[o3d-j625 r2] the in-transaction enqueue REFUSES an unchartered request as well', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } } = {}
  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    reportOutcome: (outcome: { queued: boolean; reason?: string; connector: string | null }) => {
      answered.outcome = outcome
    },
  } as unknown as Parameters<typeof queueAccountingSyncTx>[1])

  assert.equal(queued, false)
  assert.deepEqual(insertedInTx, [], 'the in-transaction path must fail closed on an absent chart too')
  assert.equal(answered.outcome?.reason, 'refused')
  assert.equal(answered.outcome?.connector, null)
})

test('[o3d-j625] the in-transaction enqueue refuses a retired chart, and reports it as owed', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } } = {}
  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    reportOutcome: (outcome) => { answered.outcome = outcome },
  })

  assert.equal(queued, false)
  assert.equal(insertedInTx.length, 0, 'nothing is inserted for a chart whose connector has been retired')
  assert.equal(answered.outcome?.reason, 'refused')
  assert.equal(answered.outcome?.connector, 'xero')
})

test('[o3d-j625] the in-transaction row follows the CHART when the selection moves between the check and the insert', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  // The same window as the facade test above: the chart check reads Xero, the switch commits, and the
  // POSTING CONTEXT and the insert must still be the chart's. Resolving the connector again here is what
  // wrote one ledger's row with the other's codes.
  selectionReads = 0
  flipToQuickBooksAfterReads = 1

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
  })

  assert.equal(queued, true)
  assert.equal(insertedInTx.length, 1)
  assert.equal(insertedInTx[0].connector, 'xero', 'the posting context and the insert follow the chart')
  assert.equal(insertedInTx[0].salesAccount, 'X-INV')
})

test('[o3d-j625] the in-transaction enqueue writes under the CHART’S connector while it is still active', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
  })

  assert.equal(queued, true)
  assert.equal(insertedInTx.length, 1)
  assert.equal(insertedInTx[0].connector, 'xero')
  assert.equal(insertedInTx[0].salesAccount, 'X-INV')
})
