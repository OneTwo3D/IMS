import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  decideInvoicePaymentPost,
  guardInvoicePaymentCapacity,
  type PostedInvoicePaymentRegistration,
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

/**
 * `bodyCouldHavePosted: true` is the DEFAULT on purpose. It is what a row whose stored body is
 * complete — or unreadable — reports, i.e. the ordinary case, and the only case that is safe to
 * assume when nothing is known. A test that wants the provably-never-sent row has to say so.
 */
function reg(
  row: Omit<PostedInvoicePaymentRegistration, 'bodyCouldHavePosted'>
    & Partial<Pick<PostedInvoicePaymentRegistration, 'bodyCouldHavePosted'>>,
): PostedInvoicePaymentRegistration {
  return { bodyCouldHavePosted: true, ...row }
}

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
    registrations: [reg({ id: 'other', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1' })],
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
    registrations: [reg({ id: 'other', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1' })],
  })
  assert.equal(verdict.post, true)
})

test('the entry s OWN row never counts against it', () => {
  // The row being posted is itself PROCESSING/SYNCED in the table it reads; counting it would make
  // every payment refuse itself, and a retry of a SYNCED-but-unfinished entry refuse its own success.
  const verdict = decide({
    registrations: [reg({ id: ENTRY, status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-1' })],
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
      reg({ id: 'sibling', status: 'PENDING', amount: 40, accountingInvoiceId: 'INV-1' }),
      reg({ id: 'claimed', status: 'PROCESSING', amount: 40, accountingInvoiceId: 'INV-1' }),
    ],
  })
  assert.equal(verdict.post, true)
})

// ---------------------------------------------------------------------------
// ROUND 3 #3: A FAILED MONEY ROW IS NOT PROOF THAT NOTHING POSTED.
//
// Round 2 filed FAILED alongside CANCELLED as "did not post", so its capacity was free. That is a
// GUESS about remote state, and it is the guess this session established is wrong: the processor
// posts before it persists the result, so a lost response, a timeout or a crash after Xero created
// the Payment all land FAILED, and errorMessage carries no provenance to tell them apart.
//
// The pinned idempotency token does not cover this. It re-drives the SAME follow-up onto the same
// remote request; a receipt recorded again after a failure is a DIFFERENT row for a DIFFERENT local
// Payment, so nothing dedupes it and this sum is the only thing between it and a second payment.
// ---------------------------------------------------------------------------

test('a FAILED registration whose body could have been sent refuses with AMBIGUOUS_FAILED_REGISTRATION', () => {
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: 'other', status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-1' })],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'AMBIGUOUS_FAILED_REGISTRATION')
  // NOT a number: there is no "already posted" figure, because whether it posted is the unknown.
  assert.equal(verdict.post === false && verdict.alreadyPosted, null)
  assert.deepEqual(verdict.post === false && verdict.ambiguousIds, ['other'])
})

test('the ambiguous refusal fires even when the arithmetic would have fitted comfortably', () => {
  // The point is not that the money does not fit. It is that IMS does not know how much of the
  // invoice the ledger holds, so there is no sum to do — a refusal that only fired on a tight
  // invoice would be an over-settlement check wearing a different name.
  const verdict = decide({
    amount: 1,
    ledgerTotal: 1000,
    registrations: [reg({ id: 'other', status: 'FAILED', amount: 1, accountingInvoiceId: 'INV-1' })],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'AMBIGUOUS_FAILED_REGISTRATION')
})

test('a FAILED registration whose stored body was INCOMPLETE frees the capacity — that one is proof', () => {
  // The single sound "nothing was sent" signal: both connectors reject a body missing a required
  // field before they build a request, so such an attempt provably never reached the ledger. Without
  // this exception the refusal would be unconditional and every later receipt on the invoice would
  // be stranded behind a request that could never have succeeded.
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: 'other', status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-1', bodyCouldHavePosted: false }),
    ],
  })
  assert.equal(verdict.post, true)
})

test('a FAILED registration against a DIFFERENT document does not make this invoice ambiguous', () => {
  // o3d-hbgo, applied to the ambiguity: an attempt on the invoice this order no longer has cannot
  // have settled the one it does have. Scoping the ambiguity the same way the arithmetic is scoped
  // keeps a re-invoiced order from being blocked for ever by its predecessor's failure.
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: 'other', status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-0' })],
  })
  assert.equal(verdict.post, true)
})

test('a CANCELLED registration still frees the capacity — CANCELLED is only ever asserted pre-call', () => {
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: 'other', status: 'CANCELLED', amount: 100, accountingInvoiceId: 'INV-1' })],
  })
  assert.equal(verdict.post, true)
})

test('this entry s OWN earlier FAILED state never blocks its own retry', () => {
  // A reused FAILED row is flipped back to PENDING and re-posts under its PINNED token, so the ledger
  // returns the original payment. Treating the row as ambiguous evidence against itself would refuse
  // every retry the idempotency work exists to make safe.
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: ENTRY, status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-1' })],
  })
  assert.equal(verdict.post, true)
})

test('a posted registration against a DIFFERENT document consumes none of this invoice s capacity', () => {
  // o3d-hbgo: the order's invoice was deleted and re-posted. The old payment settled an invoice this
  // order no longer has, and counting it would strand every payment on the replacement, for ever.
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: 'other', status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-0' })],
  })
  assert.equal(verdict.post, true)
})

test('a posted registration naming NO document still counts — unknown reads as possibly this one', () => {
  const verdict = decide({
    amount: 100,
    registrations: [reg({ id: 'other', status: 'SYNCED', amount: 100, accountingInvoiceId: null })],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
})

test('an unreadable amount on a posted registration fails CLOSED with LEDGER_AMOUNT_UNKNOWN', () => {
  // Treating it as zero would let this payment through on the assumption the ledger holds nothing,
  // which is precisely what is not known.
  const verdict = decide({
    registrations: [reg({ id: 'other', status: 'SYNCED', amount: null, accountingInvoiceId: 'INV-1' })],
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

test('a FAILED sibling row read from the database refuses, and the message tells the operator what to check', async () => {
  // END TO END for round 3 #3: receipt A timed out after Xero created the payment and landed FAILED
  // with a COMPLETE body. Receipt B is the operator recording it again. Round 2 read A as free
  // capacity and posted B — a second GBP 100 against a GBP 100 invoice, unrecoverable from IMS.
  const { client } = mockClient({
    order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: false },
    logs: [
      { id: ENTRY, status: 'PROCESSING', payload: { amount: 100, accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1' } },
      { id: 'receipt-a', status: 'FAILED', payload: { amount: 100, accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1' } },
    ],
  })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind, 'refused')
  assert.equal(
    result.post === false && result.kind === 'refused' && result.refusal,
    'AMBIGUOUS_FAILED_REGISTRATION',
  )
  assert.deepEqual(
    result.post === false && result.kind === 'refused' ? result.ambiguousIds : [],
    ['receipt-a'],
  )
  const message = result.post === false ? result.message : ''
  assert.match(message, /receipt-a/, 'the message must name the entry the operator has to look at')
  assert.match(message, /NOT proof that nothing reached the ledger/)
  assert.match(message, /Nothing was sent\./)
  assert.match(message, /Open this invoice in the ledger/)
})

test('a FAILED sibling whose stored body the connector would have rejected pre-call does not block the post', async () => {
  // Same shape, but receipt A's payload has no bankAccountId — the Xero INVOICE_PAYMENT case rejects
  // that before building a request, so it provably never reached the ledger and holds no capacity.
  const { client } = mockClient({
    order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: false },
    logs: [
      { id: ENTRY, status: 'PROCESSING', payload: { amount: 100, accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1' } },
      { id: 'receipt-a', status: 'FAILED', payload: { amount: 100, accountingInvoiceId: 'INV-1' } },
    ],
  })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  assert.equal(result.post, true)
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
