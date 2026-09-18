import test from 'node:test'
import assert from 'node:assert/strict'

import {
  queueSalesInvoiceUpdateForExistingAccountingInvoice,
  type QueueSalesInvoiceUpdateDeps,
} from '@/lib/domain/sales/sales-invoice-update-sync'

type EnqueueAnswer = { queued: boolean; reason?: 'not-configured' | 'refused' | 'already-queued'; connector: string | null }

function makeDeps(options: {
  connector: Awaited<ReturnType<QueueSalesInvoiceUpdateDeps['getActiveAccountingConnectorInfo']>>
  enabled: boolean
  /**
   * o3d-j625 r4: what the FACADE answers. `enabled: false` is the facade's `not-configured` (the chart's
   * connector does not post this type), which is what the removed `isAccountingSyncTypeEnabled` dep meant.
   */
  answer?: EnqueueAnswer
}) {
  const queued: unknown[] = []
  const activity: unknown[] = []
  const outstanding: Array<{ posting: { type: string; referenceId: string; scope: string }; reason: string; chartConnector: string | null; activeConnector: string | null; remedy: string }> = []
  const deps: QueueSalesInvoiceUpdateDeps = {
    async getActiveAccountingConnectorInfo() {
      return options.connector
    },
    async queueAccountingSync(input) {
      queued.push(input)
      return options.answer
        ?? (options.enabled ? { queued: true, connector: 'xero' } : { queued: false, reason: 'not-configured', connector: 'xero' })
    },
    async logActivity(input) {
      activity.push(input)
    },
    // o3d-j625 r4: what the refusal records as OUTSTANDING work in the exception inbox.
    async recordPostingRefusal(record) {
      outstanding.push(record)
    },
  }
  return { deps, queued, activity, outstanding }
}

const baseParams = {
  salesOrderId: 'so-1',
  orderNumber: 'SO-1001',
  accountingInvoiceId: 'xero-invoice-1',
  payload: {
    invoiceNumber: 'INV-SO-1001',
    accountingInvoiceId: 'xero-invoice-1',
    lines: [{ itemCode: 'SKU-1', quantity: 1 }],
  },
  idempotencyKey: 'sales-invoice-update:so-1:xero-invoice-1:abc123',
  // o3d-j625: whose chart the account codes in `payload` came from.
  chartConnector: 'xero' as const,
  // o3d-j625 r3: whose INVOICE the update is posted against.
  documentConnector: 'xero' as const,
  // o3d-j625 r5: the key the caller derives from these same params and the facade will match on.
  posting: { type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'so-1', scope: '' },
}

test('queueSalesInvoiceUpdateForExistingAccountingInvoice queues Xero update with idempotency key', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0], {
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: baseParams.payload,
    idempotencyKey: baseParams.idempotencyKey,
    // o3d-j625 r4: through the FACADE, so both provenance guards apply to the row.
    chartConnector: 'xero',
    documentConnector: 'xero',
  })
  assert.equal(activity.length, 1)
  assert.deepEqual(activity[0], {
    entityType: 'SALES_ORDER',
    entityId: 'so-1',
    action: 'sales_invoice_update_queued',
    tag: 'accounting',
    level: 'INFO',
    description: 'Queued sales invoice update for SO-1001 against accounting invoice xero-invoice-1',
    metadata: {
      accountingInvoiceId: 'xero-invoice-1',
      orderNumber: 'SO-1001',
      idempotencyKey: baseParams.idempotencyKey,
      alreadyQueued: false,
    },
  })
})

test('queueSalesInvoiceUpdateForExistingAccountingInvoice skips non-Xero connectors with warning activity', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'quickbooks', name: 'QuickBooks' },
    enabled: true,
  })

  // o3d-j625: the chart AGREES with the active connector here, so the refusal under test is the
  // unsupported-connector one and not the chart mismatch. A QuickBooks-charted payload offered while
  // QuickBooks is active is exactly the case this test is about.
  // o3d-j625 r3: and the INVOICE is QuickBooks' too, so the document-provenance refusal is not the one
  // exercised either.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice({ ...baseParams, chartConnector: 'quickbooks', documentConnector: 'quickbooks' }, deps)

  assert.equal(queued.length, 0)
  assert.equal(activity.length, 1)
  assert.deepEqual(activity[0], {
    entityType: 'SALES_ORDER',
    entityId: 'so-1',
    action: 'sales_invoice_update_skipped_unsupported_connector',
    tag: 'accounting',
    level: 'WARNING',
    description: 'Sales invoice update for SO-1001 was not queued because QuickBooks invoice updates are not supported yet',
    metadata: {
      accountingInvoiceId: 'xero-invoice-1',
      orderNumber: 'SO-1001',
      connector: 'quickbooks',
      idempotencyKey: baseParams.idempotencyKey,
    },
  })
})

test('queueSalesInvoiceUpdateForExistingAccountingInvoice silently skips disabled update sync type', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: false,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  // o3d-j625 r4: the facade was ASKED (that is where "is this type posted" is now answered, for the
  // chart's own connector) and answered `not-configured` — which writes nothing and owes nothing.
  assert.equal(queued.length, 1, 'PRECONDITION: the facade was asked')
  assert.equal(activity.length, 0)
})

// o3d-j625 r4 (Codex HIGH 4) — A REFUSAL FROM THE QUEUE IS NOT "QUEUED".
for (const answer of [
  { queued: false, reason: 'refused', connector: 'xero' },
  { queued: false, connector: 'xero' },
] as const) {
  test(`[o3d-j625 r4] a queue answer of ${JSON.stringify(answer)} is reported as NOT queued, never as queued`, async () => {
    const { deps, queued, activity } = makeDeps({ connector: { id: 'xero', name: 'Xero' }, enabled: true, answer })

    await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

    assert.equal(queued.length, 1, 'PRECONDITION: the enqueue was reached')
    const actions = activity.map((a) => (a as { action: string }).action)
    assert.deepEqual(actions, ['sales_invoice_update_not_queued'], 'the owed update is reported, and nothing claims it was queued')
    assert.equal((activity[0] as { level: string }).level, 'ERROR')
  })
}

test('[o3d-j625 r4] an already-queued answer is recorded as queued, and says so', async () => {
  const { deps, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' }, enabled: true, answer: { queued: true, reason: 'already-queued', connector: 'xero' },
  })
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)
  const record = activity[0] as { action: string; metadata: Record<string, unknown> }
  assert.equal(record.action, 'sales_invoice_update_queued')
  assert.equal(record.metadata.alreadyQueued, true)
})

/**
 * o3d-j625 — THE UPDATE'S ACCOUNT CODES AND ITS ROW MUST COME FROM ONE RESOLUTION.
 *
 * `queueSalesInvoiceForOrder` reads `getAccountingSettings()` — which resolves the active connector
 * internally and returns THAT connector's chart — builds the update payload out of those codes, and then
 * calls this helper, which resolved the active connector AGAIN and handed the payload to `queueXeroSync`.
 * Two independent reads: with QuickBooks active the payload is composed with QuickBooks
 * `salesAccount`/`shippingAccount`/`discountAccount`, a switch to Xero commits, and this queued that
 * document as a XERO invoice update. Xero then rejects it, or posts the order's revenue against
 * whatever those codes happen to name in its own chart.
 *
 * Nothing is written on a mismatch, and it is RECORDED: an invoice update is re-derivable from the
 * order, so refusing costs a re-save and writing the wrong one costs a wrong document in a live ledger.
 */

test('[o3d-j625] a payload built from QuickBooks’s chart is NOT queued as a Xero invoice update', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  // The window: the chart was read while QuickBooks was active, the switch to Xero committed during the
  // payload build, and Xero is what this helper resolves.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(
    { ...baseParams, chartConnector: 'quickbooks' },
    deps,
  )

  assert.equal(queued.length, 0, 'a QuickBooks-charted document must not be queued to Xero')
  assert.equal(activity.length, 1)
  const refusal = activity[0] as { action: string; description: string; metadata: Record<string, unknown> }
  assert.equal(refusal.action, 'sales_invoice_update_refused_retired_chart')
  assert.match(refusal.description, /NOTHING WAS QUEUED/)
  assert.match(refusal.description, /still OUTSTANDING/)
  assert.equal(refusal.metadata.chartConnector, 'quickbooks')
  assert.equal(refusal.metadata.connector, 'xero')
})

test('[o3d-j625] a payload built while NO connector was active is not queued either', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  // `chartConnector: null` means the chart read found nothing switched on, so every account code in the
  // payload is the empty-string default. Queueing it would post a document with no accounts on it.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(
    { ...baseParams, chartConnector: null },
    deps,
  )

  assert.equal(queued.length, 0)
  assert.equal(activity.length, 1)
  assert.equal((activity[0] as { action: string }).action, 'sales_invoice_update_refused_retired_chart')
})

test('[o3d-j625] the refusal is a MISMATCH check, not a new reason to skip Xero: an agreeing chart still queues', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 1, 'an Xero-charted update, with Xero active, is queued exactly as before')
  assert.equal((activity[0] as { action: string }).action, 'sales_invoice_update_queued')
})

// o3d-j625 r3 (Codex HIGH 2) — the chart can agree while the INVOICE id is another connector's.
for (const [label, documentConnector] of [
  ['recorded under the OTHER connector', 'quickbooks'],
  ['never recorded (a link predating the column)', null],
] as const) {
  test(`queueSalesInvoiceUpdateForExistingAccountingInvoice REFUSES an invoice ${label}, even with the chart agreeing`, async () => {
    const { deps, queued, activity } = makeDeps({ connector: { id: 'xero', name: 'Xero' }, enabled: true })

    await queueSalesInvoiceUpdateForExistingAccountingInvoice({ ...baseParams, chartConnector: 'xero', documentConnector }, deps)

    assert.equal(queued.length, 0, 'an update must not rewrite a document the active connector may not hold')
    assert.equal(activity.length, 1)
    const record = activity[0] as { action: string; metadata: Record<string, unknown> }
    assert.equal(record.action, 'sales_invoice_update_refused_unattributable_document')
    assert.equal(record.metadata.documentConnector, documentConnector)
  })
}

// o3d-j625 r4 — a refusal is OUTSTANDING work an operator can find, not only an Activity line.
test('[o3d-j625 r4] every refusal on this path records an outstanding posting carrying BOTH connectors and a remedy', async () => {
  const cases = [
    { params: { ...baseParams, chartConnector: 'quickbooks' as const }, reason: 'retired_chart' },
    { params: { ...baseParams, documentConnector: null }, reason: 'unattributable_document_id' },
  ]
  for (const { params, reason } of cases) {
    const { deps, outstanding } = makeDeps({ connector: { id: 'xero', name: 'Xero' }, enabled: true })
    await queueSalesInvoiceUpdateForExistingAccountingInvoice(params, deps)
    assert.equal(outstanding.length, 1, `${reason}: exactly one outstanding row`)
    assert.equal(outstanding[0].reason, reason)
    assert.deepEqual(outstanding[0].posting, baseParams.posting, 'keyed on the posting the enqueue itself would clear')
    assert.equal(outstanding[0].activeConnector, 'xero', 'the ACTIVE connector — the half round 2 omitted')
    assert.equal(outstanding[0].chartConnector, params.chartConnector)
    assert.ok(outstanding[0].remedy.length > 0, 'and what the operator must do')
  }

  // A queue that DECLINES is the third, and it is the one r3 could only log.
  const { deps, outstanding } = makeDeps({
    connector: { id: 'xero', name: 'Xero' }, enabled: true, answer: { queued: false, reason: 'refused', connector: 'xero' },
  })
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)
  assert.deepEqual(outstanding.map((row) => row.reason), ['enqueue_refused'])
})

test('[o3d-j625 r4] a queued update records NOTHING outstanding — the row is only for work that is owed', async () => {
  const { deps, outstanding } = makeDeps({ connector: { id: 'xero', name: 'Xero' }, enabled: true })
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)
  assert.deepEqual(outstanding, [])
})
