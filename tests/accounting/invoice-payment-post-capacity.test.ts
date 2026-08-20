import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  decideInvoicePaymentPost,
  guardInvoicePaymentCapacity,
  retireOverSettlingInvoicePayment,
} from '@/lib/domain/accounting/invoice-payment-capacity'

/**
 * o3d-cjt8, round 2 #2. Rescoping accounting_sync_logs_followup_live_unique to
 * (…, accountingInvoiceId, paymentId) stopped the DATABASE preventing an order from being over-settled
 * by several receipts, and the arithmetic moved into an under-lock re-check at the enqueue — on the
 * stated assumption that every INVOICE_PAYMENT enqueue takes lockSalesOrder.
 *
 * It does not. The imported-order path (enqueueSalesInvoiceFollowUps' `_registerPayment` branch)
 * enqueues a payment straight after the SALES_INVOICE posts, with no order lock and no capacity
 * arithmetic at all — so over-settlement protection ended up WEAKER than the index it replaced.
 *
 * The fix is not a third enqueue-side call site (that roll-call has already been wrong once) but the
 * POST: every INVOICE_PAYMENT, whatever enqueued it, must pass through the connector's INVOICE_PAYMENT
 * case to reach the ledger, so the arithmetic is enforced immediately before `xeroPost('Payments', …)`.
 */

const ENTRY = 'entry-under-test'

function decide(overrides: Partial<Parameters<typeof decideInvoicePaymentPost>[0]> = {}) {
  return decideInvoicePaymentPost({
    entryId: ENTRY,
    accountingInvoiceId: 'INV-1',
    amount: 60,
    ledgerTotal: 100,
    registrations: [],
    ...overrides,
  })
}

test('a payment that would take the invoice past its total is refused with WOULD_OVERPAY', () => {
  const verdict = decide({
    registrations: [{ id: 'other', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
  assert.equal(verdict.post === false && verdict.alreadyPosted, 60)
  assert.equal(verdict.ledgerTotal, 100)
})

test('a payment that exactly settles what is left still posts', () => {
  // The guard must not become a one-payment-per-invoice rule: a deposit and a balance are two payments.
  const verdict = decide({
    amount: 40,
    registrations: [{ id: 'other', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(verdict.post, true)
})

test('the entry s OWN row never counts against it', () => {
  // The row being posted is itself PROCESSING/SYNCED in the table it reads; counting it would make
  // every payment refuse itself, and a retry of a SYNCED-but-unfinished entry refuse its own success.
  const verdict = decide({
    registrations: [{ id: ENTRY, status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(verdict.post, true)
})

test('a PENDING sibling does not consume capacity', () => {
  // Counting queued-but-unposted rows would refuse the FIRST receipt of a deposit + balance pair
  // because its sibling is sitting in the queue behind it. Safe because
  // findInvoicePaymentsBlockedByEarlierLiveLogs lets only the earliest live entry per order run.
  const verdict = decide({
    amount: 60,
    registrations: [
      { id: 'sibling', status: 'PENDING', amount: 40, accountingInvoiceId: 'INV-1' },
      { id: 'claimed', status: 'PROCESSING', amount: 40, accountingInvoiceId: 'INV-1' },
    ],
  })
  assert.equal(verdict.post, true)
})

test('a FAILED registration frees the capacity rather than stranding every later receipt', () => {
  const verdict = decide({
    amount: 100,
    registrations: [{ id: 'other', status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(verdict.post, true)
})

test('a posted registration against a DIFFERENT document consumes none of this invoice s capacity', () => {
  // o3d-hbgo: the order's invoice was deleted and re-posted. The old payment settled an invoice this
  // order no longer has, and counting it would strand every payment on the replacement, for ever.
  const verdict = decide({
    amount: 100,
    registrations: [{ id: 'other', status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-0' }],
  })
  assert.equal(verdict.post, true)
})

test('a posted registration naming NO document still counts — unknown reads as possibly this one', () => {
  const verdict = decide({
    amount: 100,
    registrations: [{ id: 'other', status: 'SYNCED', amount: 100, accountingInvoiceId: null }],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
})

test('an unreadable amount on a posted registration fails CLOSED with LEDGER_AMOUNT_UNKNOWN', () => {
  // Treating it as zero would let this payment through on the assumption the ledger holds nothing,
  // which is precisely what is not known.
  const verdict = decide({
    registrations: [{ id: 'other', status: 'SYNCED', amount: null, accountingInvoiceId: 'INV-1' }],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'LEDGER_AMOUNT_UNKNOWN')
  assert.equal(verdict.post === false && verdict.alreadyPosted, null)
})

// ---------------------------------------------------------------------------
// DB WIRING — the reads the guard does, against a recording client.
// ---------------------------------------------------------------------------

type LogRow = { id: string; status: string; payload: unknown }

function mockClient(options: {
  order?: { totalForeign: number; taxForeign: number; pricesIncludeVat: boolean; imported: boolean } | null
  orderThrows?: boolean
  logs?: LogRow[]
}) {
  const calls = { syncFindMany: [] as Array<Record<string, unknown>> }
  const client = {
    salesOrder: {
      findUnique: async () => {
        if (options.orderThrows) throw new Error('connection terminated')
        if (options.order === null || options.order === undefined) return null
        return {
          totalForeign: options.order.totalForeign,
          taxForeign: options.order.taxForeign,
          pricesIncludeVat: options.order.pricesIncludeVat,
          shoppingLinks: options.order.imported ? [{ connector: 'woocommerce' }] : [],
        }
      },
    },
    accountingSyncLog: {
      findMany: async (args: Record<string, unknown>) => {
        calls.syncFindMany.push(args)
        return options.logs ?? []
      },
    },
  }
  return { client, calls }
}

const GUARD_PARAMS = {
  connector: 'xero',
  entryId: ENTRY,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  accountingInvoiceId: 'INV-1',
  amount: 100,
}

test('the IMPORTED-ORDER enqueue path is measured too, even though it never took the order lock', async () => {
  // THE ROUND-2 REGRESSION, END TO END. `_registerPayment` enqueued this row with no lock and no
  // capacity arithmetic. A manual receipt for the same order has already SYNCED for the full invoice,
  // so posting this one would settle a GBP 100 invoice with GBP 200 of payments.
  const { client } = mockClient({
    order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: true },
    logs: [
      { id: ENTRY, status: 'PROCESSING', payload: { amount: 100, accountingInvoiceId: 'INV-1' } },
      { id: 'manual-receipt', status: 'SYNCED', payload: { amount: 100, accountingInvoiceId: 'INV-1' } },
    ],
  })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'refused')
  assert.equal(result.post === false && result.kind === 'refused' && result.refusal, 'WOULD_OVERPAY')
  assert.match(
    result.post === false && result.kind === 'refused' ? result.message : '',
    /would over-settle it/,
  )
})

test('an imported tax-inclusive invoice is measured NET of VAT, so a gross receipt is refused', async () => {
  // o3d-cyn: only an IMPORTED tax-inclusive order posts to the ledger at NET. Measuring the gross
  // receipt against the gross order total would let a payment through that Xero itself will reject.
  const { client } = mockClient({
    order: { totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, imported: true },
    logs: [],
  })

  const result = await guardInvoicePaymentCapacity(client as never, { ...GUARD_PARAMS, amount: 120 })

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind === 'refused' && result.ledgerTotal, 100)
})

test('the same order raised IN IMS posts gross, so the same receipt is allowed', () => {
  // Guards against the fix becoming "refuse every VAT receipt".
  return (async () => {
    const { client } = mockClient({
      order: { totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, imported: false },
      logs: [],
    })
    const result = await guardInvoicePaymentCapacity(client as never, { ...GUARD_PARAMS, amount: 120 })
    assert.equal(result.post, true)
  })()
})

test('the capacity read is scoped to this connector, this type and this order', async () => {
  const { client, calls } = mockClient({
    order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: false },
    logs: [],
  })

  await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.deepEqual(calls.syncFindMany[0].where, {
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
  })
})

test('an unreadable sales order fails CLOSED as unmeasurable, not as permission to post', async () => {
  const { client } = mockClient({ orderThrows: true })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'unmeasurable')
  assert.match(result.post === false ? result.message : '', /Could not read sales order order-1/)
})

test('a missing sales order fails CLOSED as unmeasurable', async () => {
  const { client } = mockClient({ order: null })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'unmeasurable')
  assert.match(result.post === false ? result.message : '', /not found before posting an invoice payment/)
})

test('a reference this guard cannot measure fails CLOSED rather than being waved through', async () => {
  const { client } = mockClient({ order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: false } })

  const result = await guardInvoicePaymentCapacity(client as never, { ...GUARD_PARAMS, referenceType: 'Shipment' })

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'unmeasurable')
  assert.match(result.post === false ? result.message : '', /can only be measured against a SalesOrder/)
})

// ---------------------------------------------------------------------------
// Retirement of a refused entry.
// ---------------------------------------------------------------------------

test('a refused entry is retired CLAIM-FENCED, so a reclaimed or already-posted row is never rewritten', async () => {
  const updates: Array<{ where?: unknown; data?: unknown }> = []
  const client = {
    accountingSyncLog: {
      updateMany: async (args: { where?: unknown; data?: unknown }) => { updates.push(args); return { count: 1 } },
    },
  }
  const claimedAt = new Date('2026-08-20T10:00:00.000Z')

  const retired = await retireOverSettlingInvoicePayment(client as never, {
    entryId: 'entry-1',
    claimedAt,
    reason: 'would over-settle',
  })

  assert.equal(retired, true)
  assert.deepEqual(updates[0].where, {
    id: 'entry-1',
    status: 'PROCESSING',
    processingStartedAt: claimedAt,
    externalTransactionId: null,
  })
  // CANCELLED is provably accurate here: the guard runs BEFORE the remote call, so nothing was sent.
  assert.equal((updates[0].data as { status: string }).status, 'CANCELLED')
})

test('losing the claim fence retires nothing', async () => {
  const client = { accountingSyncLog: { updateMany: async () => ({ count: 0 }) } }
  const retired = await retireOverSettlingInvoicePayment(client as never, {
    entryId: 'entry-1',
    claimedAt: new Date(),
    reason: 'would over-settle',
  })
  assert.equal(retired, false)
})

// ---------------------------------------------------------------------------
// The structural claim the whole fix rests on: the guard sits at the POST, ahead of the remote call.
// Asserted against the source because a full connector harness would test the mocks, not the placement.
// ---------------------------------------------------------------------------

test('the Xero INVOICE_PAYMENT case runs the capacity guard BEFORE it posts to Xero', () => {
  const src = readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const caseStart = src.indexOf("case 'INVOICE_PAYMENT': {")
  assert.ok(caseStart > 0, 'the INVOICE_PAYMENT case must exist')
  const body = src.slice(caseStart, src.indexOf("case 'BILL_ATTACHMENT': {", caseStart))

  const guardAt = body.indexOf('guardInvoicePaymentCapacity(')
  const postAt = body.indexOf("xeroPost")
  assert.ok(guardAt > 0, 'the INVOICE_PAYMENT case must run the capacity guard')
  assert.ok(postAt > 0, 'the INVOICE_PAYMENT case must post to Xero')
  assert.ok(
    guardAt < postAt,
    'the capacity guard must run BEFORE the remote call — after it, the money has already moved',
  )
})
