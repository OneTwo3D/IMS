/**
 * o3d-j625 r3 (Codex HIGH 2, HIGH 3) — A CHART PROVES WHOSE ACCOUNT CODES A PAYLOAD CARRIES, NOT WHOSE
 * DOCUMENT IDs.
 *
 * `accountingInvoiceId` and `bankAccountId` are primary keys in the accounting system's own database.
 * The invoice id deliberately SURVIVES a connector switch (the document still exists where it was
 * posted), so after a switch the r2 chart check passes — the codes really are the active connector's —
 * while the payload still names the retired connector's document. These tests drive the REAL facade and
 * the REAL in-transaction enqueue through the same harness as chart-connector-routing.test.ts and assert
 * that a payload carrying a connector-native id is written ONLY when its provenance is declared and
 * agrees with the chart. Absent, `null` (unrecorded) and disagreeing are all refusals, and all `refused`
 * — never `not-configured`, which is the one no-op an obligation may be settled with.
 *
 * The harness below is copied verbatim from chart-connector-routing.test.ts (lines 1–253 there) rather
 * than imported, because node:test module mocks are per-file.
 */
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
      // o3d-j625 r6: posts, so the receipt-scoped cases (M2, M4) reach the idempotency check.
      xero_sync_stock_receipt: 'submitted',
      // o3d-j625 r7: the landed-cost COGS journal posts, so the H-B double-post case reaches the create.
      xero_sync_cogs_journal: 'submitted',
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

/** The refusal table as seen through a TRANSACTION client: a failing statement aborts the transaction
 *  unless a savepoint is open around it (see txModel). */
function txRefusalTable() {
  const failing = (message = 'relation "AccountingPostingRefusal" does not exist (code deployed ahead of migrate deploy)'): never => {
    if (txModel.savepointDepth === 0) txModel.aborted = true
    throw new Error(message)
  }
  return {
    upsert: async (args: Parameters<typeof postingRefusalTable.upsert>[0]) => {
      if (txModel.failRefusalWrites) failing()
      txModel.txRefusalWrites += 1
      return postingRefusalTable.upsert(args)
    },
    updateMany: async (args: Parameters<typeof postingRefusalTable.updateMany>[0]) => {
      if (txModel.failRefusalWrites) failing()
      return postingRefusalTable.updateMany(args)
    },
    findUnique: async (args: Parameters<typeof postingRefusalTable.findUnique>[0]) => {
      // o3d-j625 r8 (Codex HIGH): the SUPPRESSION READ fails, and ONLY it — the writes above still work,
      // and so does the sync-row insert, which is the whole shape of the finding. A statement timeout
      // rather than a missing relation, deliberately: r7's defence of the degrade was that the only
      // realistic failure is a schema that has not caught up, and this is the failure that defence does
      // not cover.
      if (txModel.failSuppressionRead) failing(SUPPRESSION_READ_FAILURE)
      return postingRefusalTable.findUnique(args)
    },
  }
}

/** What an UNREADABLE suppression looks like: the state is there, this session cannot see it. */
const SUPPRESSION_READ_FAILURE = '57014: canceling statement due to statement timeout'

function transactionDouble() {
  return {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    accountingPostingRefusal: txRefusalTable(),
    accountingSyncLog: {
      // o3d-j625 r6: a prior attempt the in-transaction enqueue's idempotency check can find (M2's case).
      findMany: async () => txModel.priorAttempts,
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { connector: string; type: string; payload: Record<string, unknown> } }) => {
        if (txModel.aborted) throw new Error('25P02: current transaction is aborted')
        const lines = data.payload.lines as Array<{ accountCode?: unknown }> | undefined
        insertedInTx.push({ connector: data.connector, type: data.type, salesAccount: lines?.[0]?.accountCode })
        return { id: `log-${insertedInTx.length}`, ...data }
      },
    },
    activityLog: { create: async () => ({ id: 'activity-1' }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionDouble()),
  }
}

/**
 * o3d-j625 r4 — THE EXCEPTION INBOX'S REFUSAL TABLE, MODELLED.
 *
 * Upsert and updateMany semantics rather than a spy: what the tests below assert is that a refusal is
 * SELECTABLE as outstanding work and stops being so once the posting is queued, and both are properties
 * of the stored row.
 */
const applyRefusalUpdate = (row: Record<string, unknown>, update: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(update)) {
    // Prisma's atomic increment, modelled — the row's attempt count is an assertion below, and a double
    // that stored the operator object instead of applying it would make that assertion meaningless.
    if (value && typeof value === 'object' && 'increment' in (value as object)) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment)
    } else {
      row[key] = value
    }
  }
}

type StoredAccount = { connector: string; code: string | null; externalAccountId: string; active: boolean; type: string }
const storedAccounts: StoredAccount[] = []
function accountMatches(a: StoredAccount, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(value as Array<Record<string, unknown>>).some((alt) => accountMatches(a, alt))) return false
    } else if ((a as Record<string, unknown>)[key] !== value) {
      return false
    }
  }
  return true
}

const refusals: Array<Record<string, unknown>> = []
const postingRefusalTable = {
  upsert: async ({ where, create, update }: { where: { type_referenceType_referenceId_scope: { type: string; referenceType: string; referenceId: string; scope: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const key = where.type_referenceType_referenceId_scope
    const existing = refusals.find((r) => r.type === key.type && r.referenceType === key.referenceType && r.referenceId === key.referenceId && r.scope === key.scope)
    if (existing) { applyRefusalUpdate(existing, { ...update, resolvedAt: null }); return existing }
    const row = { id: `ref-${refusals.length + 1}`, refusedCount: 1, suppressedAt: null, ...create, resolvedAt: null }
    refusals.push(row)
    return row
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    // o3d-j625 r7: the mark's own write names the ROW (id) and the kinds it may close.
    const kinds = (where.kind as { in?: unknown[] } | undefined)?.in
    const hits = refusals.filter((r) => (where.id !== undefined
      ? r.id === where.id && (!kinds || kinds.includes(r.kind))
      : r.type === where.type && r.referenceType === where.referenceType && r.referenceId === where.referenceId && r.scope === where.scope)
      && (where.resolvedAt === null ? r.resolvedAt === null : r.resolvedAt !== null))
    for (const hit of hits) Object.assign(hit, data)
    return { count: hits.length }
  },
  // o3d-j625 r7: read by the suppression check (by key) and by the mark (by id).
  findUnique: async ({ where }: { where: { id?: string; type_referenceType_referenceId_scope?: Record<string, unknown> } }) => {
    const key = where.type_referenceType_referenceId_scope
    return refusals.find((r) => (where.id !== undefined
      ? r.id === where.id
      : r.type === key!.type && r.referenceType === key!.referenceType && r.referenceId === key!.referenceId && r.scope === key!.scope)) ?? null
  },
}

/** The inbox's own predicate. */
function outstandingRefusals(): Array<Record<string, unknown>> {
  return refusals.filter((row) => row.resolvedAt === null)
}

/** The core settings table `getAccountingSettingsFor` reads its connector-agnostic values from. */
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      accountingSyncLog: { findMany: async () => [] },
      accountingToken: { findFirst: async () => null },
      // o3d-j625 r5 (review HIGH 5): the stored chart, with a where-clause EVALUATOR rather than a canned
      // answer — the property under test is which rows the confirmation's predicate admits.
      accountingAccount: { findFirst: async ({ where }: { where: Record<string, unknown> }) => storedAccounts.find((a) => accountMatches(a, where)) ?? null },
      // The POOLED client's view of the same table, counted separately: "recorded inside the caller's
      // transaction" is only observable if a write through the pool is distinguishable from one through tx.
      accountingPostingRefusal: {
        upsert: async (args: Parameters<typeof postingRefusalTable.upsert>[0]) => { txModel.pooledRefusalWrites += 1; return postingRefusalTable.upsert(args) },
        updateMany: postingRefusalTable.updateMany,
        // o3d-j625 r7/r8: the FACADE's early suppression read goes through the pooled client. Without it
        // here the read took posting-suppression.ts's "this client cannot read the table" short-circuit,
        // so the facade's own suppression answer was never exercised in this file at all.
        findUnique: async (args: Parameters<typeof postingRefusalTable.findUnique>[0]) => {
          if (txModel.failSuppressionRead) throw new Error(SUPPRESSION_READ_FAILURE)
          return postingRefusalTable.findUnique(args)
        },
      },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(transactionDouble()),
    },
  },
})

/**
 * o3d-j625 r5 (review M-14) — POSTGRES' ABORTED-TRANSACTION RULE, MODELLED.
 *
 * A statement that fails inside a transaction aborts it (25P02): every later statement fails and the commit
 * rolls back, whatever the client did with the exception. Only a savepoint contains the failure. The double
 * below applies that rule, so "the refusal write failed and the caller's transaction is still committable"
 * is a property the tests can observe rather than a claim about a try/catch.
 */
const txModel = { savepointDepth: 0, aborted: false, failRefusalWrites: false, failSuppressionRead: false, txRefusalWrites: 0, pooledRefusalWrites: 0, priorAttempts: [] as Array<{ id: string; status: string; externalTransactionId: string | null }> }
mock.module('@/lib/db/savepoint', {
  namedExports: {
    withSavepoint: async <T>(_tx: unknown, fn: () => Promise<T>): Promise<T> => {
      txModel.savepointDepth += 1
      try {
        return await fn() // a throw here is ROLLBACK TO SAVEPOINT: the transaction stays usable
      } finally {
        txModel.savepointDepth -= 1
      }
    },
  },
})

function reset(selection: string[]): void {
  refusals.length = 0
  txModel.savepointDepth = 0
  txModel.aborted = false
  txModel.failRefusalWrites = false
  txModel.failSuppressionRead = false
  txModel.txRefusalWrites = 0
  txModel.pooledRefusalWrites = 0
  txModel.priorAttempts = []
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


const CHART_CONNECTORS = ['xero', 'quickbooks'] as const

/** A payment whose payload carries the two connector-native ids the finding is about. */
function paymentRequest(type: 'INVOICE_PAYMENT' | 'BILL_PAYMENT') {
  return {
    type,
    referenceType: type === 'INVOICE_PAYMENT' ? 'SalesOrder' : 'PurchaseInvoice',
    referenceId: 'doc-1',
    payload: { accountingInvoiceId: 'XERO-INV-1', bankAccountId: 'XERO-BANK-1', amount: 100 },
  }
}

// --------------------------------------------------------------------------------------------
// THE RIG CAN SEE THE DEFECT: without the provenance rule, a switched connector writes the row
// --------------------------------------------------------------------------------------------

test('[o3d-j625 r3] PRECONDITION: a payment carrying a document id IS written when its provenance agrees — the rule is not "always refuse"', async () => {
  reset(['quickbooks'])
  const { queueAccountingSync } = await import('@/lib/accounting')

  const outcome = await queueAccountingSync({
    ...paymentRequest('INVOICE_PAYMENT'),
    chartConnector: 'quickbooks',
    documentConnector: 'quickbooks',
  })

  assert.equal(outcome.queued, true)
  assert.equal(routed.length, 1, 'the control case writes exactly one row')
  assert.equal(routed[0].queue, 'quickbooks')
})

// --------------------------------------------------------------------------------------------
// FAMILY A — the three ways provenance can fail to be established, on both enqueues
// --------------------------------------------------------------------------------------------

for (const [label, documentConnector] of [
  ['UNDECLARED (a site that never thought about provenance)', undefined],
  ['NULL (the link predates the column that records it — fail closed)', null],
  ['the OTHER connector (the id survived the switch)', 'xero'],
] as const) {
  test(`[o3d-j625 r3] facade: a payload carrying a document id attributed to ${label} is REFUSED, and says so`, async () => {
    reset(['quickbooks'])
    const { queueAccountingSync } = await import('@/lib/accounting')

    // The chart check passes on its own: QuickBooks' chart, QuickBooks active. That is exactly the state
    // after a switch in which r2 approved the payment.
    const outcome = await queueAccountingSync({
      ...paymentRequest('INVOICE_PAYMENT'),
      chartConnector: 'quickbooks',
      ...(documentConnector === undefined ? {} : { documentConnector }),
    })

    assert.equal(routed.length, 0, 'NOTHING may be written against a document the target ledger may not hold')
    assert.equal(outcome.queued, false)
    assert.equal(outcome.reason, 'refused', 'refused, never not-configured: the payment is still owed')
    const record = activity.find((a) => a.action === 'accounting_enqueue_refused_unattributable_document_id')
    assert.ok(record, 'the refusal is RECORDED — most sites that reach this ignore the return value')
    assert.deepEqual(record.metadata?.connectorNativePayloadKeys, ['accountingInvoiceId', 'bankAccountId'])
    assert.equal(record.metadata?.documentConnectorDeclared, documentConnector !== undefined)
  })

  test(`[o3d-j625 r3] in-transaction: a payload carrying a document id attributed to ${label} is REFUSED`, async () => {
    reset(['quickbooks'])
    const { queueAccountingSyncTx } = await import('@/lib/accounting')

    const answered: { outcome?: { queued: boolean; reason?: string; connector: string | null } } = {}
    const queued = await queueAccountingSyncTx(transactionDouble() as never, {
      ...paymentRequest('BILL_PAYMENT'),
      chartConnector: 'quickbooks',
      ...(documentConnector === undefined ? {} : { documentConnector }),
      reportOutcome: (outcome) => { answered.outcome = outcome },
    })

    assert.equal(queued, false)
    assert.deepEqual(insertedInTx, [], 'nothing is inserted')
    assert.equal(answered.outcome?.reason, 'refused')
  })
}

test('[o3d-j625 r3] the rule is read off the PAYLOAD, so a payload with NO document id needs no declaration', async () => {
  // Otherwise every journal site would have to declare a provenance it has nothing to declare about,
  // and an optional parameter that every caller passes as noise is a parameter nobody reads.
  for (const chart of CHART_CONNECTORS) {
    reset([chart])
    const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
    const settings = await getAccountingSettings()
    const outcome = await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
    assert.equal(outcome.queued, true, `${chart}: a code-only payload is unaffected`)
  }
})

test('[o3d-j625 r3] every connector-native key is guarded, each on its own', async () => {
  const { CONNECTOR_NATIVE_PAYLOAD_ID_KEYS } = await import('@/lib/accounting')
  // Match count printed and asserted, so a key list that shrank to nothing cannot pass by examining nothing.
  assert.deepEqual([...CONNECTOR_NATIVE_PAYLOAD_ID_KEYS].sort(), [
    'accountingCreditNoteId',
    'accountingInvoiceId',
    'allocateToInvoiceId',
    'bankAccountId',
    'creditNoteId',
  ].sort())
  let refusedCount = 0
  for (const key of CONNECTOR_NATIVE_PAYLOAD_ID_KEYS) {
    reset(['quickbooks'])
    const { queueAccountingSync } = await import('@/lib/accounting')
    const outcome = await queueAccountingSync({
      type: 'PURCHASE_CREDIT_NOTE',
      referenceType: 'SupplierCreditNote',
      referenceId: 'cn-1',
      payload: { [key]: 'SOME-NATIVE-ID' },
      chartConnector: 'quickbooks',
      documentConnector: null,
    })
    assert.equal(outcome.reason, 'refused', `${key} with no provenance is refused`)
    assert.equal(routed.length, 0, `${key}: nothing written`)
    refusedCount++
  }
  assert.equal(refusedCount, 5)
})

test('[o3d-j625 r3] an EMPTY id is not an id — a payload with `accountingInvoiceId: ""` is not refused for provenance', async () => {
  reset(['xero'])
  const { queueAccountingSync } = await import('@/lib/accounting')
  const outcome = await queueAccountingSync({
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    payload: { accountingInvoiceId: '', amount: 1 },
    chartConnector: 'xero',
  })
  assert.equal(outcome.queued, true)
  assert.equal(activity.some((a) => a.action === 'accounting_enqueue_refused_unattributable_document_id'), false)
})

test('[o3d-j625 r3] a recorded value this build cannot route is `null`, never narrowed to a supported one', async () => {
  const { asRoutableAccountingConnector } = await import('@/lib/accounting')
  assert.equal(asRoutableAccountingConnector('xero'), 'xero')
  assert.equal(asRoutableAccountingConnector('quickbooks'), 'quickbooks')
  assert.equal(asRoutableAccountingConnector('shiphero'), null)
  assert.equal(asRoutableAccountingConnector(''), null)
  assert.equal(asRoutableAccountingConnector(null), null)
  assert.equal(asRoutableAccountingConnector(undefined), null)
})

// --------------------------------------------------------------------------------------------
// o3d-j625 r4 — the chart-scoped posting verdict, against the real plugin selection and settings
// --------------------------------------------------------------------------------------------

test('[o3d-j625 r4] accountingPostingVerdictForChart keeps "chart retired" apart from "type switched off"', async () => {
  const { accountingPostingVerdictForChart } = await import('@/lib/accounting')

  reset(['xero'])
  assert.deepEqual(await accountingPostingVerdictForChart('xero', 'SALES_INVOICE'), { verdict: 'post', connector: 'xero' })
  // Posting mode for this type is not in the Xero settings double, i.e. switched off, while Xero is active.
  assert.deepEqual(await accountingPostingVerdictForChart('xero', 'COGS_REVERSAL'), { verdict: 'not-configured', connector: 'xero' })
  // The chart is Xero's and QuickBooks is active: owed, not off — whatever QuickBooks' own toggles say.
  reset(['quickbooks'])
  assert.deepEqual(await accountingPostingVerdictForChart('xero', 'SALES_INVOICE'), { verdict: 'chart-retired', chartConnector: 'xero', activeConnector: 'quickbooks' })
  reset([])
  assert.deepEqual(await accountingPostingVerdictForChart('xero', 'SALES_INVOICE'), { verdict: 'chart-retired', chartConnector: 'xero', activeConnector: null })
  assert.deepEqual(await accountingPostingVerdictForChart(null, 'SALES_INVOICE'), { verdict: 'no-chart' })
})


// ---------------------------------------------------------------------------------------------------
// o3d-j625 r4 — A REFUSAL IS OUTSTANDING WORK, AND THE POSTING BEING MADE IS WHAT CLEARS IT.
// ---------------------------------------------------------------------------------------------------

test('[o3d-j625 r4] a refused posting becomes an OUTSTANDING inbox row naming BOTH connectors and a remedy', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  const outcome = await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })

  assert.equal(outcome.reason, 'refused', 'PRECONDITION: this is the refusal path')
  const rows = outstandingRefusals()
  assert.equal(rows.length, 1, `the refusal is durable and selectable. Rows: ${JSON.stringify(refusals)}`)
  assert.equal(rows[0].type, 'SALES_INVOICE')
  assert.equal(rows[0].referenceType, 'SalesOrder')
  assert.equal(rows[0].referenceId, 'order-1')
  assert.equal(rows[0].chartConnector, 'xero', 'the chart the codes came from')
  assert.equal(rows[0].activeConnector, 'quickbooks', 'AND what is active now — the half round 2 omitted')
  assert.equal(rows[0].reason, 'retired_chart')
  assert.match(String(rows[0].remedy), /back to xero/)
})

test('[o3d-j625 r4] the SAME posting refused again updates one row rather than filling the inbox', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })

  assert.equal(outstandingRefusals().length, 1)
  assert.equal(outstandingRefusals()[0].refusedCount, 2, 'and the row counts both attempts')
})

test('[o3d-j625 r4] the posting being QUEUED clears the outstanding row — nothing else does', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  // Refused while the chart's connector is retired…
  enabledPlugins = ['quickbooks']
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  assert.equal(outstandingRefusals().length, 1, 'PRECONDITION: the debt was recorded')

  // …and the selection settles back, so the same posting is re-queued from its source document.
  enabledPlugins = ['xero']
  const outcome = await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })

  assert.equal(outcome.queued, true, 'PRECONDITION: this time it really was queued')
  assert.deepEqual(outstandingRefusals(), [], 'the row clears when the posting is MADE')
  assert.equal(refusals.length, 1, 'and the record that the gap existed is kept, resolved')
  assert.ok(refusals[0].resolvedAt, 'stamped with when it was resolved')
})


/** The in-transaction request shape, as chart-connector-routing.test.ts uses it. */
const TX_REQUEST = {
  type: 'INVENTORY_ADJUSTMENT' as const,
  referenceType: 'StockMovement',
  referenceId: 'movement-1',
  unlockedOrderScopeReason: 'test harness: the order guard is doubled to a non-order scope',
}

test('[o3d-j625 r5 HIGH 4] the IN-TRANSACTION enqueue records its refusal when the caller asks, inside the caller’s transaction', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    // What the invoice-payment registration and the allocation trim now pass: their local state COMMITS
    // whatever this answers, so the debt is real and must be recorded — r4 recorded nothing on this path.
    recordRefusalAsOutstanding: true,
  })

  assert.equal(queued, false, 'PRECONDITION: the retired chart refused')
  assert.deepEqual(insertedInTx, [], 'and wrote no sync row')
  const rows = outstandingRefusals()
  assert.equal(rows.length, 1, `the refusal is outstanding. Rows: ${JSON.stringify(refusals)}`)
  assert.equal(rows[0].type, TX_REQUEST.type)
  assert.equal(rows[0].referenceId, TX_REQUEST.referenceId)
  assert.equal(rows[0].chartConnector, 'xero')
  assert.equal(rows[0].activeConnector, 'quickbooks', 'both connectors, as the refusal saw them')
  assert.equal(txModel.txRefusalWrites, 1, 'written through the CALLER\'S TRANSACTION, so it commits with the state that made the debt real')
  assert.equal(txModel.pooledRefusalWrites, 0, 'and not through the pool, where it would survive the caller rolling back')
})

test('[o3d-j625 r5] the in-transaction enqueue records NOTHING when the caller does not ask — its work rolls back', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']

  await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
  })

  assert.deepEqual(outstandingRefusals(), [],
    'the bill payment and the supplier credit note ROLL BACK on a refusal, so an outstanding row there '
    + 'would be a debt nobody owes')
})

test('[o3d-j625 r5 M-13] a posting refused, made, then refused again reports the NEW gap — not the first one', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  enabledPlugins = ['quickbooks']
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  const firstEpisode = refusals[0]!
  assert.equal(firstEpisode.refusedCount, 2, 'PRECONDITION: two attempts in the first episode')
  const firstOpenedAt = firstEpisode.firstRefusedAt

  // The posting is made: the gap closes.
  enabledPlugins = ['xero']
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  assert.deepEqual(outstandingRefusals(), [])

  // And a LATER switch opens a NEW gap. r4 carried the first episode's timestamp and count forward, so the
  // inbox aged a fresh debt from a gap that had already been closed — falsifying the column's own contract.
  enabledPlugins = ['quickbooks']
  await queueAccountingSync({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })

  const reopened = outstandingRefusals()
  assert.equal(reopened.length, 1)
  assert.equal(reopened[0].refusedCount, 1, 'this episode has had one attempt')
  assert.notEqual(reopened[0].firstRefusedAt, firstOpenedAt, 'and it is aged from when THIS gap opened')
})

test('[o3d-j625 r5 M-14] a refusal row that cannot be WRITTEN does not abort the caller’s transaction', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']
  txModel.failRefusalWrites = true

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    recordRefusalAsOutstanding: true,
  })

  assert.equal(queued, false, 'PRECONDITION: refused')
  assert.equal(txModel.aborted, false,
    'the failed refusal write was contained by a savepoint — without one the goods receipt, bill or MO '
    + 'completion that called this rolls back with an opaque 25P02')
})

test('[o3d-j625 r5 M-14] a CLEAR that cannot be written does not abort the transaction the posting is queued in', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  txModel.failRefusalWrites = true
  insertedInTx.length = 0

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
  })

  assert.equal(queued, true, 'PRECONDITION: queued, so the clear ran')
  assert.equal(insertedInTx.length, 1, 'PRECONDITION: the sync row was written in the transaction')
  assert.equal(txModel.aborted, false, 'and the transaction that holds it is still committable')
})

test('[o3d-j625 r5 HIGH 5] the payment-account confirmation admits what the POSTER admits — id OR code, any type, archived too', async () => {
  const { accountingBankAccountBelongsTo } = await import('@/lib/accounting')
  storedAccounts.length = 0
  // What the settings UI can store: a synced id, a Xero account CODE typed into the free-text field, and a
  // non-BANK clearing account offered because the chart held no BANK-type account.
  storedAccounts.push(
    { connector: 'xero', code: '090', externalAccountId: 'xero-uuid-bank', active: true, type: 'BANK' },
    { connector: 'xero', code: '810', externalAccountId: 'xero-uuid-clearing', active: true, type: 'CURRLIAB' },
    { connector: 'xero', code: '091', externalAccountId: 'xero-uuid-archived', active: false, type: 'BANK' },
  )

  assert.equal(await accountingBankAccountBelongsTo('xero', 'xero-uuid-bank'), true, 'the synced id')
  assert.equal(await accountingBankAccountBelongsTo('xero', '090'), true,
    'a CODE — r4 matched the id only, so every payment mapped by code was refused for ever as unmapped')
  assert.equal(await accountingBankAccountBelongsTo('xero', 'xero-uuid-clearing'), true,
    'a non-BANK account — the poster does not filter on type, so neither may the confirmation')
  assert.equal(await accountingBankAccountBelongsTo('xero', '091'), true,
    'an archived account — rejected by the ledger, loudly, at post time; not silently refused here')
})

test('[o3d-j625 r5 HIGH 5] CONTROL: the confirmation still refuses a value that is not in THIS connector\'s chart', async () => {
  const { accountingBankAccountBelongsTo } = await import('@/lib/accounting')
  storedAccounts.length = 0
  storedAccounts.push({ connector: 'xero', code: '090', externalAccountId: 'xero-uuid-bank', active: true, type: 'BANK' })

  assert.equal(await accountingBankAccountBelongsTo('quickbooks', '090'), false, 'another connector\'s code')
  assert.equal(await accountingBankAccountBelongsTo('quickbooks', 'xero-uuid-bank'), false, 'another connector\'s id')
  assert.equal(await accountingBankAccountBelongsTo('xero', 'nope'), false, 'a value in no chart at all')
  assert.equal(await accountingBankAccountBelongsTo('xero', ''), false, 'nothing mapped')
})

test('[o3d-j625 r6 H2] a second allocation-reversal TRIM queued does not clear the first trim\'s refusal', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  // The real payload shape (allocation-service.ts): each call mints its own `_reversalToken`.
  const trim = (token: string) => ({
    ...TX_REQUEST,
    type: 'ALLOCATION_REVERSAL' as const,
    payload: { _reversalToken: token, lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    recordRefusalAsOutstanding: true,
  })

  enabledPlugins = ['quickbooks']
  assert.equal(await queueAccountingSyncTx(transactionDouble() as never, trim('trim-1')), false, 'PRECONDITION: trim 1 refused')
  assert.equal(outstandingRefusals().length, 1, 'PRECONDITION: and recorded as outstanding')

  enabledPlugins = ['xero']
  assert.equal(await queueAccountingSyncTx(transactionDouble() as never, trim('trim-2')), true, 'PRECONDITION: trim 2 queued')

  assert.equal(outstandingRefusals().length, 1,
    'trim 1\'s pounds are still in Allocated Inventory — r5 keyed every trim of an order alike, so trim 2 cleared it')
  assert.equal(outstandingRefusals()[0]!.scope, 'reversal:trim-1')
})

test('[o3d-j625 r6 M2] an in-transaction enqueue that finds the posting ALREADY QUEUED clears that posting\'s row — and only it', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  const request = {
    ...TX_REQUEST,
    type: 'STOCK_RECEIPT' as const,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    idempotencyKey: 'purchase-receipt:po-1:GRN-2:h',
    chartConnector: settings.connector,
  }
  // Two open refusals on one reference: THIS receipt's, and a DIFFERENT receipt's.
  const open = (scope: string) => ({ type: 'STOCK_RECEIPT', referenceType: TX_REQUEST.referenceType, referenceId: TX_REQUEST.referenceId, scope, resolvedAt: null, refusedCount: 1 })
  refusals.push(open('purchase-receipt:po-1:GRN-2:h'), open('purchase-receipt:po-1:GRN-1:h'))
  // A live prior attempt for this key: nothing is written, the answer is `already-queued`.
  txModel.priorAttempts = [{ id: 'prior-1', status: 'PENDING', externalTransactionId: null }]
  insertedInTx.length = 0

  assert.equal(await queueAccountingSyncTx(transactionDouble() as never, request), true)
  assert.equal(insertedInTx.length, 0, 'PRECONDITION: already queued — no row written, so only the answer can clear')
  assert.deepEqual(outstandingRefusals().map((row) => row.scope), ['purchase-receipt:po-1:GRN-1:h'],
    'the receipt found queued is discharged; the other receipt is still owed')
})

// o3d-j625 r6 (review M4) — EVERY IN-TRANSACTION REFUSAL HONOURS `recordRefusalAsOutstanding`, not only the
// chart check. The unresolved-prior-attempt and unserviced-pin refusals leave the same committed local state.
test('[o3d-j625 r6 M4] an UNRESOLVED prior attempt refuses — and, when asked, records the refusal in the caller\'s transaction', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  txModel.priorAttempts = [{ id: 'failed-1', status: 'FAILED', externalTransactionId: null }]
  const reported: { outcome?: Record<string, unknown> } = {}

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    type: 'STOCK_RECEIPT' as const,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    idempotencyKey: 'purchase-receipt:po-1:GRN-9:h',
    chartConnector: settings.connector,
    recordRefusalAsOutstanding: true,
    reportOutcome: (outcome) => { reported.outcome = outcome as unknown as Record<string, unknown> },
  })

  assert.equal(queued, false, 'PRECONDITION: refused')
  assert.equal(outstandingRefusals().length, 1)
  assert.equal(outstandingRefusals()[0]!.reason, 'unresolved_prior_attempt')
  assert.equal(outstandingRefusals()[0]!.scope, 'purchase-receipt:po-1:GRN-9:h')
  assert.equal(txModel.txRefusalWrites, 1, 'through the caller\'s transaction')
  assert.equal(reported.outcome?.refusalRecorded, true, 'and the answer says so, so the caller merges instead of recounting')
})

test('[o3d-j625 r6 M4] a PINNED ledger the selection no longer services refuses — and records, when asked', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()

  const queued = await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    connector: 'xero',
    recordRefusalAsOutstanding: true,
  })

  assert.equal(queued, false, 'PRECONDITION: the locked read of the plugin rows finds none, so the pin is not serviced')
  assert.equal(outstandingRefusals().length, 1)
  assert.equal(outstandingRefusals()[0]!.reason, 'pinned_ledger_not_serviced')
})

test('[o3d-j625 r6 M4] CONTROL: the same refusals record nothing when the caller did not ask (its work rolls back)', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  txModel.priorAttempts = [{ id: 'failed-1', status: 'FAILED', externalTransactionId: null }]

  await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    type: 'STOCK_RECEIPT' as const,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    idempotencyKey: 'purchase-receipt:po-1:GRN-9:h',
    chartConnector: settings.connector,
  })
  assert.deepEqual(outstandingRefusals(), [])
})

// o3d-j625 r6 (review L1): the in-transaction answer dropped `activeConnector` and `refusalRecorded` on the
// chart refusal, so a caller reporting it recounted the refusal and wrote the chart connector as active.
test('[o3d-j625 r6 L1] the in-transaction answer carries the active connector and that the row was recorded', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  enabledPlugins = ['quickbooks']
  const reported: { outcome?: Record<string, unknown> } = {}

  await queueAccountingSyncTx(transactionDouble() as never, {
    ...TX_REQUEST,
    payload: { lines: [{ accountCode: settings.inventoryAccount, debit: 10 }] },
    chartConnector: settings.connector,
    recordRefusalAsOutstanding: true,
    reportOutcome: (outcome) => { reported.outcome = outcome as unknown as Record<string, unknown> },
  })

  assert.equal(reported.outcome?.reason, 'refused', 'PRECONDITION')
  assert.equal(reported.outcome?.activeConnector, 'quickbooks')
  assert.equal(reported.outcome?.refusalRecorded, true)
})

// ---------------------------------------------------------------------------------------------------
// o3d-j625 r7 (review H-B) — THE DOUBLE POST THE REVIEW FOUND, DRIVEN.
//
// r6 classified a landed-cost journal refused by a direct caller as manual-only, while the landed-cost
// outbox retries the SAME posting (same idempotency key) ~90s later. So: refused → an operator posts it by
// hand and marks it handled → the connector selection settles → the outbox drains → the journal is posted
// AGAIN. The outbox reaches the ledger through queueAccountingSyncTx and the row-creating primitive, which
// is what is driven here, with the params queueLandedCostAdjustmentJournals passes.
// ---------------------------------------------------------------------------------------------------
test('[o3d-j625 r7 H-B] refused → marked handled → the outbox drains → NOT posted, and the activity says so', async () => {
  reset(['xero'])
  const { getAccountingSettings, queueAccountingSyncTx } = await import('@/lib/accounting')
  const { landedCostAdjustmentIdempotencyKey } = await import('@/lib/domain/purchasing/landed-cost-service')
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const { markPostingHandled } = await import('@/lib/domain/accounting/posting-mark-handled')
  const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
  const settings = await getAccountingSettings()
  const adjustment = { primaryPoId: 'po-1', primaryPoRef: 'PO-1', freightPoId: null, eventKey: 'recalc-1', totalDelta: 12.5 }
  const journal = () => ({
    type: 'COGS_JOURNAL' as const,
    referenceType: 'PurchaseOrder',
    referenceId: 'po-1',
    idempotencyKey: landedCostAdjustmentIdempotencyKey('cogs', adjustment as never),
    payload: { lines: [{ accountCode: settings.cogsAccount, debit: 12.5 }] },
    chartConnector: settings.connector,
  })

  // 1. Refused: the connector moved under the recalculation. The reporting site records the row.
  enabledPlugins = ['quickbooks']
  insertedInTx.length = 0
  assert.equal(await queueAccountingSyncTx(transactionDouble() as never, journal()), false, 'PRECONDITION: refused')
  await recordAccountingPostingRefusal({ accountingPostingRefusal: postingRefusalTable } as never, accountingPostingKey(journal()), {
    kind: 'landed_cost_cogs_journal', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'c', remedy: 'r',
  })
  const row = outstandingRefusals()[0]!
  assert.equal(row.kind, 'landed_cost_cogs_journal', 'PRECONDITION: recorded as outstanding')

  // 2. Posted by hand, and marked handled.
  const marked = await markPostingHandled(transactionDouble() as never, { id: String(row.id), userId: 'user-1', note: 'MJ-77' })
  assert.equal(marked.ok, true, `PRECONDITION: the mark succeeded (${JSON.stringify(marked)})`)

  // 3. The cause clears and the outbox drains the same recalculation.
  enabledPlugins = ['xero']
  activity.length = 0
  const answered: { outcome?: { queued: boolean; reason?: string } } = {}
  const queued = await queueAccountingSyncTx(transactionDouble() as never, { ...journal(), reportOutcome: (o) => { answered.outcome = o } })

  assert.deepEqual(insertedInTx, [], 'NOTHING was written: the journal is in the ledger once, by hand')
  assert.equal(queued, true, 'and the outbox is told the counterpart exists, so it stops retrying')
  assert.equal(answered.outcome?.reason, 'handled-by-hand')
  assert.ok(activity.some((a) => a.action === 'accounting_posting_suppressed_handled_by_hand'),
    `and the refusal to post it is visible. Activity: ${JSON.stringify(activity.map((a) => a.action))}`)
})

test('[o3d-j625 r7 H-B] the primitive itself refuses a suppressed key, under the lock — no enqueue path can post around it', async () => {
  reset(['xero'])
  const { createAccountingSyncLogRow } = await import('@/lib/domain/accounting/sync-log-row')
  refusals.push({ id: 'ref-x', type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', referenceId: 'po-9', scope: 'k-9', kind: 'landed_cost_cogs_journal', resolvedAt: new Date(), suppressedAt: new Date(), refusedCount: 1 })
  const locks: string[] = []
  const created: unknown[] = []
  const client = {
    $executeRaw: async (strings: TemplateStringsArray) => { locks.push(strings.join('?')); return 1 },
    accountingPostingRefusal: postingRefusalTable,
    accountingSyncLog: { create: async (args: unknown) => { created.push(args); return { id: 'row-1' } } },
  }
  const row = await createAccountingSyncLogRow(client as never, {
    connector: 'xero', type: 'COGS_JOURNAL', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId: 'po-9',
    payload: { _idempotencyKey: 'k-9' },
  } as never)
  assert.equal(row, null)
  assert.deepEqual(created, [], 'no row')
  assert.equal(locks.length, 1, 'the per-key lock was taken before the suppression was read')
  // CONTROL: a different posting on the same PO is written.
  const other = await createAccountingSyncLogRow(client as never, {
    connector: 'xero', type: 'COGS_JOURNAL', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId: 'po-9',
    payload: { _idempotencyKey: 'k-10' },
  } as never)
  assert.deepEqual(other, { id: 'row-1' })
})

// ---------------------------------------------------------------------------------------------------
// o3d-j625 r8 (Codex HIGH) — AN UNREADABLE SUPPRESSION IS NOT PERMISSION TO POST.
//
// r7's `readPostingSuppression` logged a failed lookup and returned `{ suppressed: false }`, and the
// primitive then created a PENDING sync row. So a lookup that failed AFTER an operator marked the posting
// handled queued, durably, the very posting the "Handled + stop retry" decision exists to stop IMS
// posting — and the connector posts it a second time. Measured before the fix against a real Postgres
// transaction with the failure injected on that one query: one PENDING row, committed.
//
// The two tests below pin the two answers an unreadable state must never give: a written row, and
// `handled-by-hand`, which tells `postingIsOwed()` and the landed-cost outbox that the ledger has it.
// ---------------------------------------------------------------------------------------------------

test('[o3d-j625 r8 HIGH] the primitive REFUSES when the suppression cannot be READ — it does not write the row', async () => {
  reset(['xero'])
  const { createAccountingSyncLogRow } = await import('@/lib/domain/accounting/sync-log-row')
  const { PostingSuppressionUnreadableError } = await import('@/lib/domain/accounting/posting-suppression')
  refusals.push({
    id: 'ref-r8', type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', referenceId: 'po-r8', scope: 'k-r8',
    kind: 'landed_cost_cogs_journal', resolvedAt: new Date(), resolution: 'handled_manually', suppressedAt: new Date(), refusedCount: 1,
  })
  const tx = transactionDouble()
  const journalRow = (idempotencyKey: string) => ({
    connector: 'xero', type: 'COGS_JOURNAL', status: 'PENDING', referenceType: 'PurchaseOrder', referenceId: 'po-r8',
    payload: { _idempotencyKey: idempotencyKey, lines: [{ accountCode: 'X-COGS', debit: 12.5 }] },
  })

  // PRECONDITION: with the read WORKING, this exact posting is refused and nothing is written.
  assert.equal(await createAccountingSyncLogRow(tx as never, journalRow('k-r8') as never), null,
    'PRECONDITION: a READABLE suppression refuses')
  assert.deepEqual(insertedInTx, [], 'PRECONDITION: and writes nothing')

  // PRECONDITION / CONTROL: the insert this test claims does NOT happen is reachable through this same
  // double. Without this, "nothing was written" could be passing because nothing can ever be written.
  assert.ok(await createAccountingSyncLogRow(tx as never, journalRow('k-r8-unsuppressed') as never),
    'PRECONDITION: an unsuppressed posting IS created')
  assert.equal(insertedInTx.length, 1, 'PRECONDITION: the create double really inserts')
  insertedInTx.length = 0
  activity.length = 0

  // THE DEFECT: the suppression read, and only it, fails.
  txModel.failSuppressionRead = true
  await assert.rejects(
    () => createAccountingSyncLogRow(tx as never, journalRow('k-r8') as never),
    (error: unknown) => error instanceof PostingSuppressionUnreadableError
      && /COGS_JOURNAL for PurchaseOrder po-r8/.test((error as Error).message)
      && (error as { retryable?: unknown }).retryable === true,
    'an unreadable suppression must REFUSE the enqueue, not fall through to the insert',
  )
  assert.deepEqual(insertedInTx, [],
    'NOTHING was written. r7 wrote a PENDING row here, for a posting already in the ledger by hand')
  assert.equal(txModel.aborted, false,
    'and the refusal is a DECISION, not a poisoned transaction: the savepoint contained the failure, which is '
    + 'exactly why r7 was able to carry on past it and insert')
  assert.ok(activity.some((a) => a.action === 'accounting_posting_suppression_unreadable'),
    `the refusal is reported. Activity: ${JSON.stringify(activity.map((a) => a.action))}`)
  const report = activity.find((a) => a.action === 'accounting_posting_suppression_unreadable')!
  assert.match(report.description, /did NOT queue it/, 'and the report says what was DONE about it, not just what failed')
  assert.match(report.description, /57014/, 'and names the cause')
})

test("[o3d-j625 r8 HIGH] the facade refuses a suppression it cannot read, and never answers 'handled-by-hand' for one", async () => {
  reset(['xero'])
  const { accountingPostingKey, getAccountingSettings, queueAccountingSync } = await import('@/lib/accounting')
  const { PostingSuppressionUnreadableError } = await import('@/lib/domain/accounting/posting-suppression')
  const settings = await getAccountingSettings()
  const request = () => ({ ...salesInvoiceRequest(settings.salesAccount), chartConnector: settings.connector })
  const key = accountingPostingKey(request())
  refusals.push({
    id: 'ref-r8f', ...key, kind: 'sales_invoice_held_release', resolvedAt: new Date(), resolution: 'handled_manually',
    suppressedAt: new Date(), refusedCount: 1,
  })

  // PRECONDITION: with the read working the facade gives the answer that STOPS every retry.
  const handled = await queueAccountingSync(request())
  assert.equal(handled.queued, true, 'PRECONDITION: a readable suppression answers queued')
  assert.equal(handled.reason, 'handled-by-hand', 'PRECONDITION: …as handled-by-hand')
  assert.equal(routed.length, 0, 'PRECONDITION: and writes nothing')

  // THE DEFECT: that answer means "a counterpart exists in the ledger and nothing is owed" —
  // postingIsOwed() reads it as settled and the landed-cost outbox stops re-driving. A state nobody could
  // read may not produce it.
  txModel.failSuppressionRead = true
  await assert.rejects(
    () => queueAccountingSync(request()),
    (error: unknown) => error instanceof PostingSuppressionUnreadableError,
    'an unreadable suppression must not be answered at all, least of all as handled-by-hand',
  )
  assert.equal(routed.length, 0, 'and nothing was written')
  assert.deepEqual(outstandingRefusals(), [],
    'and no refusal was recorded over a posting that may already be in the ledger by hand')
})
