import { isRegisteredAccountingConnector } from '@/lib/connectors/accounting-registry'
import type { StoredAccountingConnector } from '@/lib/accounting/connector-provenance'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  maybeQueuePurchaseInvoiceUpdate,
  type PurchaseInvoiceUpdateSyncDeps,
} from '@/lib/domain/purchasing/purchase-invoice-update-sync'

type ActivityLogCreateCall = {
  data: {
    action: string
    level: string
    metadata: {
      invoiceId: string
      accountingInvoiceId: string
      connector: string | null
      idempotencyKey: string
    }
  }
}

function basePayload() {
  return {
    accountingInvoiceId: 'xero-bill-1',
    // invoiceNumber is the SUPPLIER's number; reference is OUR PO ref (o3d-6l3). This fixture
    // used to carry the PO ref as invoiceNumber, encoding the very mapping that let a second
    // instalment upsert over the first in Xero.
    invoiceNumber: 'SUPPLIER-INV-9001',
    reference: 'PO-1',
    contactName: 'Supplier',
    date: '2026-06-12',
    currency: 'GBP',
    currencyRateToBase: 1,
    lines: [
      {
        description: 'PO PO-1 line',
        quantity: 1,
        unitAmount: 10,
        accountCode: '1400',
      },
    ],
  }
}

function baseParams<Tx extends { activityLog: { create: (input: ActivityLogCreateCall) => Promise<void> } }>(
  tx: Tx,
  deps: PurchaseInvoiceUpdateSyncDeps<Tx>,
  // o3d-j625 r2: the CALLER's chart connector. It replaced the active-connector dependency outright —
  // this function no longer resolves the connector for itself, because the payload's transit account and
  // tax-type code came from the caller's settings read and a second resolution is the o3d-j625 defect.
  // So the tests that used to vary that dependency now vary this.
  chartConnector: StoredAccountingConnector | null = 'xero',
  // o3d-j625 r3: whose BILL `accountingPayload.accountingInvoiceId` is. Defaulted to the chart so the
  // existing cases keep testing what they tested; varied by the r3 case below.
  documentConnector: StoredAccountingConnector | null = chartConnector,
) {
  return {
    tx,
    syncEnabled: true,
    invoiceId: 'bill-1',
    poId: 'po-1',
    poReference: 'PO-1',
    accountingInvoiceId: 'xero-bill-1',
    accountingPayload: basePayload(),
    chartConnector,
    documentConnector,
    idempotencyKey: 'purchase-invoice-update:hash',
    previousSubtotalBase: 0,
    newSubtotalBase: 0,
    deps,
  }
}

test('maybeQueuePurchaseInvoiceUpdate queues Xero PURCHASE_INVOICE_UPDATE when enabled', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async () => {},
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
      return true
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.equal(result, 'queued')
  assert.equal(activityLogCalls.length, 0)
  assert.deepEqual(queueCalls, [
    {
      type: 'PURCHASE_INVOICE_UPDATE',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      payload: basePayload(),
      idempotencyKey: 'purchase-invoice-update:hash',
      // o3d-j625 r2: the caller's chart travels to the enqueue, so the row and the payload's transit
      // account are one resolution.
      chartConnector: 'xero',
      documentConnector: 'xero',
      // o3d-j625 r13 (independent review, HIGH): the module reads the enqueue's REASON, not just its
      // boolean, because `handled-by-hand` answers `queued: true` while writing no row — and the transit
      // subledger movement below it is keyed to a row. Asserted as a function rather than matched away, so
      // dropping the callback (and with it the guard) fails here.
      reportOutcome: queueCalls.at(-1) !== undefined
        ? (queueCalls.at(-1) as { reportOutcome?: unknown }).reportOutcome
        : undefined,
    },
  ])
  assert.equal(typeof (queueCalls[0] as { reportOutcome?: unknown }).reportOutcome, 'function',
    'the enqueue is asked for the whole answer: without `reportOutcome` the module cannot tell a row it '
    + 'queued from a posting a human posted, and the transit movement would be written for both')
})

/**
 * o3d-j625 r13 (independent review, HIGH) — `queued: true` IS NOT "IMS WROTE A ROW", AND THE SUBLEDGER
 * MOVEMENT IS KEYED TO A ROW.
 *
 * `handled-by-hand` answers `queued: true` deliberately: a counterpart exists because a human posted it, and
 * `postingIsOwed` is right to read it that way. It is the WRONG answer to the question this module's transit
 * write asks, which is "is there a GL journal for the movement I am about to record". The review's chain
 * ended here — a suppressed posting answered `queued: true`, a transit movement of (new − previous) was
 * recorded, and the subledger claimed a movement the GL never received while
 * `purchaseInvoiceUpdateIsOwed('queued')` reported nothing owed.
 *
 * The scoping fix in posting-mark-handled.ts makes `handled-by-hand` unreachable for THIS type (its key is
 * shared by successive edits, so it no longer suppresses at all). This test pins the guard that makes the
 * SHAPE unreachable whatever a later change does to that, by asking about the row rather than the counterpart.
 */
test('[o3d-j625 r13] an enqueue answering handled-by-hand records NO transit movement', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const movements: unknown[] = []
  const tx = { activityLog: { create: async (input: ActivityLogCreateCall) => { activityLogCalls.push(input) } } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async (_tx, input) => { movements.push(input) },
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    // The posting was marked handled: a counterpart exists in the ledger because a human posted it, and IMS
    // wrote NOTHING. Both halves of that are what the real enqueue answers in this state.
    queueAccountingSyncTx: async (_tx, input) => {
      (input as { reportOutcome?: (o: { queued: boolean; reason?: string }) => void })
        .reportOutcome?.({ queued: true, reason: 'handled-by-hand' })
      return true
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.deepEqual(movements, [],
    'THE FINDING: no transit-subledger movement may be recorded for a GL journal that does not exist. The '
    + 'guard asks whether IMS QUEUED a row, not whether a counterpart exists — those are different questions '
    + 'and `queued: true` is the answer to the second one.')
  // The outcome stays 'queued', and that is deliberate: nothing is OWED (a human posted it), which is what
  // `purchaseInvoiceUpdateIsOwed` is asked. Flipping it to a refusal would report a hand-posted update as
  // outstanding work for ever and invite a second posting.
  assert.equal(result, 'queued',
    'nothing is owed — a counterpart exists — so the outcome is still `queued`; what changed is only that '
    + 'the subledger is not told about a journal IMS never queued')
})

test('maybeQueuePurchaseInvoiceUpdate logs unsupported connector without queueing', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async () => {},
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
      return true
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps, 'quickbooks'))

  assert.equal(result, 'skipped-unsupported-connector')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 1)
  assert.equal(activityLogCalls[0]?.data.action, 'purchase_invoice_update_skipped_unsupported_connector')
  assert.equal(activityLogCalls[0]?.data.level, 'WARNING')
  assert.deepEqual(activityLogCalls[0]?.data.metadata, {
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    connector: 'quickbooks',
    idempotencyKey: 'purchase-invoice-update:hash',
  })
})

test('maybeQueuePurchaseInvoiceUpdate skips disabled sync type without warning log', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async () => {},
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'not-configured' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
      return true
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.equal(result, 'skipped-disabled')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 0)
})

test('maybeQueuePurchaseInvoiceUpdate skips bills without external accounting id', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async () => {},
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
      return true
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate({
    ...baseParams(tx, deps),
    accountingInvoiceId: null,
    idempotencyKey: null,
  })

  assert.equal(result, 'skipped-no-external-id')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 0)
})

test('maybeQueuePurchaseInvoiceUpdate records the signed transit delta (new − old net subtotal) — 6oyu.4', async () => {
  const transitRows: Array<{ sourceType: string; sourceRef: string; idempotencyKey: string; baseDelta: number; journalDate: string }> = []
  const tx = { activityLog: { create: async (_input: ActivityLogCreateCall) => {} } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async () => true,
    recordTransitSubledgerMovement: async (_tx, input) => {
      transitRows.push({ ...input, baseDelta: Number(input.baseDelta) })
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate({
    ...baseParams(tx, deps),
    previousSubtotalBase: 100,
    newSubtotalBase: 130.5,
  })

  assert.equal(result, 'queued')
  assert.equal(transitRows.length, 1)
  assert.equal(transitRows[0]!.sourceType, 'PURCHASE_BILL_UPDATE')
  assert.equal(transitRows[0]!.sourceRef, 'po-1')
  assert.equal(transitRows[0]!.idempotencyKey, 'purchase-invoice-update:hash')
  // The bill's net (transit) leg rose by 30.50 → transit DEBIT delta of +30.50.
  assert.equal(transitRows[0]!.baseDelta, 30.5)
  assert.equal(transitRows[0]!.journalDate, '2026-06-12')
})

test('maybeQueuePurchaseInvoiceUpdate does not record a transit row when the update is not queued — 6oyu.4', async () => {
  const transitRows: unknown[] = []
  const tx = { activityLog: { create: async (_input: ActivityLogCreateCall) => {} } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async () => true,
    recordTransitSubledgerMovement: async (_tx, input) => { transitRows.push(input) },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate({
    ...baseParams(tx, deps, 'quickbooks'),
    previousSubtotalBase: 100,
    newSubtotalBase: 130.5,
  })

  assert.equal(result, 'skipped-unsupported-connector')
  assert.equal(transitRows.length, 0)
})

test('maybeQueuePurchaseInvoiceUpdate does not record a transit row when the queue declines (type disabled) — 6oyu.4', async () => {
  const transitRows: unknown[] = []
  const tx = { activityLog: { create: async (_input: ActivityLogCreateCall) => {} } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    // queue declines (e.g. no active posting context) — no GL counterpart exists.
    queueAccountingSyncTx: async () => false,
    recordTransitSubledgerMovement: async (_tx, input) => { transitRows.push(input) },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate({
    ...baseParams(tx, deps),
    previousSubtotalBase: 100,
    newSubtotalBase: 130.5,
  })

  // o3d-j625 r3 (Codex HIGH 1 family): this asserted `'queued'` for a queue that DECLINED — the test
  // was pinning the defect. The subledger half was right (no transit row); the answer to the caller was
  // not, and the caller's activity log recorded the edit as pushed on the strength of it.
  assert.equal(result, 'refused')
  assert.equal(transitRows.length, 0)
})

// o3d-j625 r4 (Codex HIGH 3) — a chart whose connector is no longer active is a REFUSAL, not a skip.
test('[o3d-j625 r4] maybeQueuePurchaseInvoiceUpdate REFUSES when the chart’s connector has been retired — never skipped-disabled', async () => {
  const tx = { activityLog: { create: async (_input: ActivityLogCreateCall) => {} } }
  let enqueues = 0
  const asked: Array<[unknown, unknown]> = []
  // The race in the finding: the chart is Xero's, and by the time the gate asks, the active connector is a
  // QuickBooks that does not post bill updates. `isAccountingSyncTypeEnabled` — the dependency this seam
  // used to take — answers `false` in that state, and it is supplied here too (by cast: it is no longer in
  // the type) so that the old code, run against this test, takes its `skipped-disabled` exit instead of
  // failing on a missing function.
  const deps = {
    isAccountingSyncTypeEnabled: async () => false,
    postingVerdictForChart: async (chart: StoredAccountingConnector | null, type: 'PURCHASE_INVOICE_UPDATE') => {
      asked.push([chart, type])
      // o3d-j625 r12 (merging o3d-remove-parked-connectors): this said `activeConnector: 'quickbooks'`.
      // With one registered connector "a DIFFERENT connector is active" cannot be expressed; `null` —
      // nothing switched on — is the retired-chart state that remains observable, and it is the one this
      // case is actually about (a retired chart is a REFUSAL, not `skipped-disabled`).
      return { verdict: 'chart-retired' as const, chartConnector: 'xero' as const, activeConnector: null }
    },
    queueAccountingSyncTx: async () => { enqueues++; return true },
    recordTransitSubledgerMovement: async () => {},
  } as unknown as PurchaseInvoiceUpdateSyncDeps<typeof tx>
  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))
  assert.deepEqual(asked, [['xero', 'PURCHASE_INVOICE_UPDATE']], 'the verdict is asked OF THE CHART’S connector')
  assert.equal(result, 'refused-chart-retired')
  assert.equal(enqueues, 0)
})

// ---------------------------------------------------------------------------------------------------
// o3d-j625 r6 (review H2 + M1) — THE BILL-UPDATE REFUSAL IS KEYED ON THE BILL, AND ON WHAT THE ENQUEUE USES.
//
// r5's refusal re-typed `PURCHASE_INVOICE_UPDATE/PurchaseOrder/<po>`, and the key function treated the type
// as document-scoped — so on a PO holding two bills, bill B's successful update cleared bill A's refusal.
// Driven through the real functions: the key the refusal site writes (`purchaseInvoiceUpdatePostingKey`)
// is compared with the key derived from the params the enqueue was ACTUALLY called with, and then with the
// key the row-creating primitive clears for the row those params produce.
// ---------------------------------------------------------------------------------------------------
async function enqueuedParamsFor(accountingInvoiceId: string, idempotencyKey: string) {
  const calls: Array<Record<string, unknown>> = []
  const tx = { activityLog: { create: async () => {} } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async () => {},
    postingVerdictForChart: async (chart) => (isRegisteredAccountingConnector(chart)
      ? { verdict: 'post' as const, connector: chart }
      : chart ? { verdict: 'chart-retired' as const, chartConnector: chart, activeConnector: null } : { verdict: 'no-chart' as const }),
    queueAccountingSyncTx: async (_tx, input) => { calls.push(input as unknown as Record<string, unknown>); return true },
  }
  const params = { ...baseParams(tx, deps), accountingInvoiceId, accountingPayload: { ...basePayload(), accountingInvoiceId }, idempotencyKey }
  await maybeQueuePurchaseInvoiceUpdate(params)
  assert.equal(calls.length, 1, 'PRECONDITION: the enqueue was called')
  return { enqueued: calls[0]!, params }
}

test('[o3d-j625 r6 H2/M1] the refusal site writes the key the enqueue derives — for each bill on one PO', async () => {
  const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
  const { purchaseInvoiceUpdatePostingKey } = await import('@/lib/domain/purchasing/purchase-invoice-update-sync')
  for (const bill of ['xero-bill-A', 'xero-bill-B']) {
    const { enqueued, params } = await enqueuedParamsFor(bill, `purchase-invoice-update:${bill}:hash`)
    assert.deepEqual(
      purchaseInvoiceUpdatePostingKey(params),
      accountingPostingKey(enqueued as never),
      'the refusal row and the enqueue must name the same posting',
    )
  }
  const a = purchaseInvoiceUpdatePostingKey((await enqueuedParamsFor('xero-bill-A', 'k1')).params)
  const b = purchaseInvoiceUpdatePostingKey((await enqueuedParamsFor('xero-bill-B', 'k1')).params)
  assert.notDeepEqual(a, b, 'two bills on one purchase order are two postings')
})

test('[o3d-j625 r6 H2/H3] bill B\'s update row does not clear bill A\'s refusal; bill A\'s own row does', async () => {
  const { purchaseInvoiceUpdatePostingKey } = await import('@/lib/domain/purchasing/purchase-invoice-update-sync')
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const { createAccountingSyncLogRow } = await import('@/lib/domain/accounting/sync-log-row')

  const refusals: Array<Record<string, unknown>> = []
  const same = (row: Record<string, unknown>, key: Record<string, unknown>) =>
    row.type === key.type && row.referenceType === key.referenceType && row.referenceId === key.referenceId && row.scope === key.scope
  const client = {
    accountingPostingRefusal: {
      upsert: async ({ where, create }: { where: { type_referenceType_referenceId_scope: Record<string, unknown> }; create: Record<string, unknown> }) => {
        const existing = refusals.find((row) => same(row, where.type_referenceType_referenceId_scope))
        if (existing) return existing
        const row = { ...create, resolvedAt: null }
        refusals.push(row)
        return row
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const wantResolved = where.resolvedAt !== null && typeof where.resolvedAt === 'object'
        const hits = refusals.filter((row) => same(row, where) && (wantResolved ? row.resolvedAt !== null : row.resolvedAt === null))
        for (const hit of hits) Object.assign(hit, data)
        return { count: hits.length }
      },
    },
    accountingSyncLog: { create: async () => ({ id: 'row' }) },
  }

  const billA = await enqueuedParamsFor('xero-bill-A', 'purchase-invoice-update:A:h1')
  await recordAccountingPostingRefusal(client, purchaseInvoiceUpdatePostingKey(billA.params), {
    kind: 'purchase_invoice_update', chartConnector: 'xero', activeConnector: null, reason: 'retired_chart', committed: 'c', remedy: 'r',
  })
  const rowFrom = (enqueued: Record<string, unknown>) => ({
    connector: 'xero', status: 'PENDING', type: enqueued.type, referenceType: enqueued.referenceType,
    referenceId: enqueued.referenceId, payload: { ...(enqueued.payload as object), _idempotencyKey: enqueued.idempotencyKey },
  }) as never

  const billB = await enqueuedParamsFor('xero-bill-B', 'purchase-invoice-update:B:h1')
  await createAccountingSyncLogRow(client, rowFrom(billB.enqueued))
  assert.equal(refusals.filter((row) => row.resolvedAt === null).length, 1, 'bill B posting does not discharge bill A')

  // Bill A re-saved later: a DIFFERENT content hash, the same bill — one obligation.
  const billAAgain = await enqueuedParamsFor('xero-bill-A', 'purchase-invoice-update:A:h2')
  await createAccountingSyncLogRow(client, rowFrom(billAAgain.enqueued))
  assert.equal(refusals.filter((row) => row.resolvedAt === null).length, 0, 'bill A\'s own update clears it')
})
