import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { enqueueNeedsNoFurtherAction, isShadowedOutcome, postingIsOwed } from '@/lib/domain/accounting/enqueue-outcome'
import { maybeQueuePurchaseInvoiceUpdate, purchaseInvoiceUpdateIsOwed, type PurchaseInvoiceUpdateSyncDeps } from '@/lib/domain/purchasing/purchase-invoice-update-sync'
import { queueSalesInvoiceUpdateForExistingAccountingInvoice, type QueueSalesInvoiceUpdateDeps } from '@/lib/domain/sales/sales-invoice-update-sync'
import { openRefundAccountingObligationLedger } from '@/lib/domain/sales/refund-accounting-obligations'

/**
 * A SHADOWED ENQUEUE IS ITS OWN STATE: NOT QUEUED, NOT OWED.
 *
 * The producer-side hold records a shadow instead of queuing a posting. The enqueue used to answer `queued: true` for it,
 * so every site that gated a ledger-mirroring write (a transit or COGS subledger row) or a "queued"/"posted" claim on
 * `queued` took the shadow for a posting that would be sent. It now answers `queued: false, reason: 'shadowed'`, and
 * `postingIsOwed` is false for it: nothing to roll back, no refusal debt, and nothing mirrored.
 *
 * Each arm names the CONSUMER it covers; the census of every consumer is in the PR. The real enqueue's answer is asserted in
 * tests/db/xero-producer-seam.test.ts and the two purchase actions are driven in shadow-outcome-supplier-credit-note and
 * shadow-outcome-bill-payment.
 */

const SHADOW = { queued: false as const, reason: 'shadowed' as const }

test('the three states are told apart by the one vocabulary: queued, shadowed, owed', () => {
  assert.equal(isShadowedOutcome({ queued: false, reason: 'shadowed' }), true)
  assert.equal(isShadowedOutcome({ queued: true }), false)
  assert.equal(isShadowedOutcome({ queued: false, reason: 'refused' }), false)
  // the shadow owes nothing
  assert.equal(postingIsOwed(SHADOW), false)
  assert.equal(postingIsOwed({ queued: false, reason: 'refused' }), true)
  assert.equal(postingIsOwed({ queued: false }), true)
  assert.equal(postingIsOwed({ queued: false, reason: 'hand-post-deferred' }), true)
  assert.equal(postingIsOwed({ queued: false, reason: 'not-configured' }), false)
  // and is not a queue
  assert.equal(SHADOW.queued, false)
  assert.equal(enqueueNeedsNoFurtherAction(SHADOW), true)
  assert.equal(enqueueNeedsNoFurtherAction({ queued: true }), true)
  assert.equal(enqueueNeedsNoFurtherAction({ queued: false, reason: 'refused' }), false)
})

// ───────────────────────── purchase bill edit: the transit delta guard ─────────────────────────

function billUpdateRun(answer: { queued: boolean; reason?: string }) {
  const transit: unknown[] = []
  const tx = { activityLog: { create: async () => undefined } }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    recordTransitSubledgerMovement: async (_tx, input) => { transit.push(input) },
    postingVerdictForChart: async () => ({ verdict: 'post' as const, connector: 'xero' as const }),
    queueAccountingSyncTx: async (_tx, params) => { params.reportOutcome?.(answer); return answer.queued },
  }
  return { transit, run: () => maybeQueuePurchaseInvoiceUpdate({
    tx, syncEnabled: true, invoiceId: 'bill-1', poId: 'po-1', poReference: 'PO-1', accountingInvoiceId: 'xero-bill-1',
    accountingPayload: { accountingInvoiceId: 'xero-bill-1', date: '2026-06-12' } as never,
    chartConnector: 'xero', documentConnector: 'xero', idempotencyKey: 'k', previousSubtotalBase: 10, newSubtotalBase: 14, deps,
  }) }
}

test('BILL EDIT: a shadowed update writes no transit delta and is reported as shadowed - neither "queued" nor a refusal', async () => {
  const shadow = billUpdateRun(SHADOW)
  assert.equal(await shadow.run(), 'shadowed')
  assert.deepEqual(shadow.transit, [], 'a transit movement mirrors a queued journal')
  assert.equal(purchaseInvoiceUpdateIsOwed('shadowed'), false, 'a shadow owes nothing, so no refusal row and no ERROR log')
  // CONTROL: a real queue writes the delta and says queued; a decline says refused.
  const live = billUpdateRun({ queued: true })
  assert.equal(await live.run(), 'queued')
  assert.equal(live.transit.length, 1)
  assert.equal(await billUpdateRun({ queued: false, reason: 'refused' }).run(), 'refused')
})

// ───────────────────────── sales invoice edit ─────────────────────────

function salesUpdateRun(answer: { queued: boolean; reason?: 'shadowed' | 'refused'; connector: string | null }) {
  const activity: Array<{ action: string; level: string; description: string }> = []
  const outstanding: unknown[] = []
  const deps: QueueSalesInvoiceUpdateDeps = {
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero', name: 'Xero' }),
    queueAccountingSync: async () => answer,
    logActivity: async (entry) => { activity.push(entry) },
    recordPostingRefusal: async (record) => { outstanding.push(record) },
  }
  return queueSalesInvoiceUpdateForExistingAccountingInvoice({
    salesOrderId: 'so-1', orderNumber: 'SO-1', accountingInvoiceId: 'xero-invoice-1', payload: { lines: [] },
    idempotencyKey: 'k', chartConnector: 'xero', documentConnector: 'xero',
  }, deps).then(() => ({ activity, outstanding }))
}

test('SALES INVOICE EDIT: a shadow is logged as NOT queued (INFO), records no refusal debt, and never says "Queued"', async () => {
  const shadow = await salesUpdateRun({ queued: false, reason: 'shadowed', connector: 'xero' })
  assert.deepEqual(shadow.activity.map((a) => [a.action, a.level]), [['sales_invoice_update_shadowed', 'INFO']])
  assert.match(shadow.activity[0]!.description, /was NOT queued/)
  assert.doesNotMatch(shadow.activity[0]!.description, /^Queued/)
  assert.deepEqual(shadow.outstanding, [], 'a shadow owes nothing')
  // CONTROLS
  const queued = await salesUpdateRun({ queued: true, connector: 'xero' })
  assert.deepEqual(queued.activity.map((a) => a.action), ['sales_invoice_update_queued'])
  const refused = await salesUpdateRun({ queued: false, reason: 'refused', connector: 'xero' })
  assert.deepEqual(refused.activity.map((a) => a.action), ['sales_invoice_update_not_queued'])
  assert.equal(refused.outstanding.length, 1)
})

// ───────────────────────── refund hand-off ledger and the refund subledger rows ─────────────────────────

test('REFUND OBLIGATIONS: a shadowed enqueue still accounts for the obligation (as before), on both arms', async () => {
  const obligation = { type: 'CREDIT_NOTE' as const, referenceType: 'SalesOrderRefund', referenceId: 'r-1' }
  for (const arm of ['account', 'accountInTransaction'] as const) {
    const ledger = await openRefundAccountingObligationLedger([obligation], { activeConnector: async () => 'xero', isTypeEnabledFor: async () => true })
    ledger[arm](obligation, { ...SHADOW, connector: 'xero' })
    assert.doesNotThrow(() => ledger.settle(), arm)
    // CONTROL: an enqueue that wrote nothing is still unmet.
    const unmet = await openRefundAccountingObligationLedger([obligation], { activeConnector: async () => 'xero', isTypeEnabledFor: async () => true })
    unmet[arm](obligation, { queued: false, reason: 'refused', connector: 'xero' })
    assert.throws(() => unmet.settle(), /./, arm)
  }
})

test('CENSUS: no production code answers a shadow as `queued: true`', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'generated') walk(path); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      // code lines only: a comment may describe the old shape
      const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
      if (/queued:\s*true\s*,\s*reason:\s*'shadowed'/.test(code)) offenders.push(path)
    }
  }
  for (const root of ['lib', 'app']) walk(join(process.cwd(), root))
  assert.deepEqual(offenders, [])
})
