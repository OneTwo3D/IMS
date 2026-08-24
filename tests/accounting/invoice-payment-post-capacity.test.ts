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
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'

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
type RegDefaults = 'bodyCouldHavePosted' | 'settlementBasis' | 'provenNeverAttempted' | 'paymentId'

function reg(
  row: Omit<PostedInvoicePaymentRegistration, RegDefaults>
    & Partial<Pick<PostedInvoicePaymentRegistration, RegDefaults>>,
): PostedInvoicePaymentRegistration {
  // o3d-anu8: `settlementBasis: null` is the connector's own writeback, i.e. the ordinary case, for
  // the same reason `bodyCouldHavePosted: true` is the default. A test that wants an
  // OPERATOR-ASSERTED row has to say so.
  //
  // Codex round 2: `provenNeverAttempted: false` for the same reason again. "Cannot prove nothing
  // was sent" is the ordinary reading of a FAILED money row, and a default of `true` would silently
  // clear every ambiguity test in this file.
  // o3d-ekn8 r4: `paymentId: null` is the un-attributed row — the shape of everything queued before
  // the payload recorded which receipt it was for. It is the ordinary case and the one that has to
  // read as "possibly this one", so a test about a SPECIFIC receipt has to name it.
  return { bodyCouldHavePosted: true, settlementBasis: null, provenNeverAttempted: false, paymentId: null, ...row }
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

// ---------------------------------------------------------------------------
// CODEX ROUND 2, HIGH — THE ROW'S OWN RECORD IS THE SECOND PROOF THAT NOTHING WAS SENT.
//
// The body test can only clear failures a connector detects by READING the payload. Both connectors
// also fail after that and before the send — QuickBooks on a customer reference or a bank account it
// resolves from the database, Xero on a lost write lease or a refused money fence — and those rows
// have complete payloads. Read as ambiguous, they terminally refuse every later receipt on the
// invoice.
// ---------------------------------------------------------------------------

test('a FAILED registration PROVEN never attempted frees the capacity even with a complete body', () => {
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({
        id: 'other',
        status: 'FAILED',
        amount: 100,
        accountingInvoiceId: 'INV-1',
        // The body is perfect — this is the case the body test cannot reach.
        bodyCouldHavePosted: true,
        provenNeverAttempted: true,
      }),
    ],
  })
  assert.equal(verdict.post, true)
})

test('the attempt proof does NOT free capacity on a POSTED row — it is only about the ambiguous set', () => {
  // A SYNCED row is the connector's writeback after the ledger answered; nothing about attempt
  // provenance can unsay that. Wiring the new fact into the arithmetic would be a different, and
  // wrong, change.
  const verdict = decide({
    amount: 60,
    registrations: [
      reg({ id: 'other', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1', provenNeverAttempted: true }),
    ],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'WOULD_OVERPAY')
})

test('a FAILED registration that is merely UNSTAMPED is still ambiguous — absence is not proof', () => {
  // `provenNeverAttempted` is false for a row outside stamping custody as well as for one that was
  // attempted, and both must keep failing closed. This is the assertion that stops the fix being
  // written as "no remoteAttemptedAt means it never posted", which is the reading round 10 of
  // o3d-0m56 spent three findings dismantling.
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: 'other', status: 'FAILED', amount: 100, accountingInvoiceId: 'INV-1', provenNeverAttempted: false }),
    ],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'AMBIGUOUS_FAILED_REGISTRATION')
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

test('ANOTHER receipt s registration against a DIFFERENT document consumes none of this invoice s capacity', () => {
  // o3d-hbgo: the order's invoice was deleted and re-posted. That payment settled an invoice this
  // order no longer has, and counting it would strand every payment on the replacement, for ever.
  //
  // o3d-ekn8 r4 narrowed this to what o3d-hbgo actually established: it is an ARITHMETIC statement
  // about capacity, and it holds for a payment that was for a DIFFERENT RECEIPT. Both receipts are
  // named here, because a row that could be speaking for THIS one is evidence and not arithmetic —
  // see the two tests below.
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: ENTRY, status: 'PENDING', amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-2' }),
      reg({ id: 'other', status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-0', paymentId: 'pay-1' }),
    ],
  })
  assert.equal(verdict.post, true)
})

// ---------------------------------------------------------------------------
// o3d-ekn8 r4 (Codex HIGH) — THE ANCHORING TRADED SILENT UNDER-SETTLEMENT FOR SILENT
// OVER-SETTLEMENT.
//
// Receipt P is SYNCED against invoice A. The order's invoice id moves to B — reachable, because the
// delete guard swallows the back-reference write failure. EVERY gate then discards that row: the
// selector, the enqueue's `live` filter, the anchored idempotency key, and this guard, all narrowed
// identically. The row is SYNCED, so the unresolved-attempt probe never consults the ledger. Nothing
// between the selector and the remote payment POST could catch it, and a SECOND payment posts for
// the same receipt.
//
// The safety argument — "the old document has been deleted, so its payment went with it" — is an
// assumption about a ledger this code never reads. On QuickBooks a deleted invoice leaves its
// payment as an UNAPPLIED CREDIT: the customer is credited twice.
//
// This guard is the backstop, because it is the one gate no enqueue path can skip.
// ---------------------------------------------------------------------------

test('[o3d-ekn8 r4] THIS receipt s own registration against a RETIRED document refuses the post', () => {
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: ENTRY, status: 'PENDING', amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1' }),
      // The payment that was actually SENT, against the invoice that has since been deleted.
      reg({ id: 'retired', status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-0', paymentId: 'pay-1' }),
    ],
  })
  assert.equal(verdict.post, false, 'sending this would pay the same receipt twice')
  assert.equal(verdict.post === false && verdict.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
  assert.deepEqual(verdict.post === false && verdict.ambiguousIds, ['retired'], 'and it names the row to go and read')
})

test('[o3d-ekn8 r4] an UN-ATTRIBUTED registration against a retired document refuses too', () => {
  // The legacy shape: queued before the payload recorded which receipt it was for. It cannot be
  // shown to belong to a different receipt, and for money unknown reads as "possibly this one".
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: ENTRY, status: 'PENDING', amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1' }),
      reg({ id: 'retired', status: 'SYNCED', amount: 100, accountingInvoiceId: 'INV-0', paymentId: null }),
    ],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'SETTLED_ON_RETIRED_DOCUMENT')
})

test('[o3d-ekn8 r4] a CANCELLED retired-document row clears it — that is the operator saying they read the ledger', () => {
  // The only thing that IS evidence. Cancelling the row is a human asserting the ledger no longer
  // holds that payment, which is the fact this code cannot establish for itself — so the replacement
  // invoice becomes settleable again, and o3d-ekn8's "never silently unsettled for ever" survives.
  const verdict = decide({
    amount: 100,
    registrations: [
      reg({ id: ENTRY, status: 'PENDING', amount: 100, accountingInvoiceId: 'INV-1', paymentId: 'pay-1' }),
      reg({ id: 'retired', status: 'CANCELLED', amount: 100, accountingInvoiceId: 'INV-0', paymentId: 'pay-1' }),
    ],
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

type LogRow = {
  id: string
  status: string
  payload: unknown
  /**
   * Codex round 2: the attempt-provenance pair the guard now selects. Defaulted by `logRow` below so
   * every existing case keeps the conservative reading — custody NULL, i.e. "this row cannot prove
   * anything", which is what a row written before custody shipped looks like.
   */
  remoteAttemptedAt?: Date | null
  attemptStampingCustodyAt?: Date | null
}

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
        return (options.logs ?? []).map((row) => ({
          remoteAttemptedAt: null,
          attemptStampingCustodyAt: null,
          ...row,
        }))
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

test('the guard SELECTS the attempt-provenance pair, and a pre-call row read from the database frees the invoice', async () => {
  // The pure rule above is only real if the columns are asked for: an unselected column arrives
  // `undefined`, `attemptProvenNeverMade` reads that as "cannot tell", and every such row stays
  // ambiguous for ever. So this asserts the query AND the outcome together.
  const { client, calls } = mockClient({
    order: { totalForeign: 100, taxForeign: 0, pricesIncludeVat: false, imported: false },
    logs: [
      { id: ENTRY, status: 'PROCESSING', payload: { amount: 100, accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1' } },
      {
        // The QuickBooks shape: complete body, refused on a customer reference before any call left.
        id: 'receipt-a',
        status: 'FAILED',
        payload: { amount: 100, accountingInvoiceId: 'INV-1', bankAccountId: 'bank-1' },
        remoteAttemptedAt: null,
        attemptStampingCustodyAt: new Date('2026-08-20T08:00:00.000Z'),
      },
    ],
  })

  const result = await guardInvoicePaymentCapacity(client as never, GUARD_PARAMS)

  const select = (calls.syncFindMany[0] as { select?: Record<string, unknown> }).select ?? {}
  assert.equal(select.remoteAttemptedAt, true, 'an unselected column can never prove anything')
  assert.equal(select.attemptStampingCustodyAt, true, 'and neither column proves anything without the other')
  assert.equal(result.post, true)
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

test('a tax-inclusive invoice is measured at GROSS however the order arrived, so a gross receipt fits', async () => {
  // SUPERSEDED ASSERTION (o3d-m5qk). This test used to be
  //   'an imported tax-inclusive invoice is measured NET of VAT, so a gross receipt is refused'
  // and required ledgerTotal 100 with post:false. o3d-cyn round 4 (merged as #631) removed the NET
  // construction path entirely: BOTH paths now post the order's gross, and `ledgerSalesInvoiceTotalForeign`
  // returns `totalForeign` whatever the tax flags say. The old expectation is not merely stale — asserting
  // it would demand the guard refuse every ordinary VAT receipt on an imported order, which is the
  // regression o3d-cyn's own counter-test exists to prevent.
  //
  // What this still pins is the thing the original was protecting: the guard measures the receipt against
  // whatever the LEDGER holds, taken from one function, rather than recomputing a total of its own.
  const imported = mockClient({
    order: { totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, imported: true },
    logs: [],
  })
  const raisedInIms = mockClient({
    order: { totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, imported: false },
    logs: [],
  })

  const importedResult = await guardInvoicePaymentCapacity(imported.client as never, { ...GUARD_PARAMS, amount: 120 })
  const imsResult = await guardInvoicePaymentCapacity(raisedInIms.client as never, { ...GUARD_PARAMS, amount: 120 })

  assert.equal(importedResult.post, true)
  assert.equal(imsResult.post, true, 'and the two agree — provenance no longer changes the ledger total')
})

test('a receipt that exceeds the gross invoice is still refused, and the refusal names the ledger total', async () => {
  // The counter-guard the pair above needs: "measured at gross" must not become "measured against
  // nothing". A penny over the whole invoice, with no other registration, still refuses.
  const { client } = mockClient({
    order: { totalForeign: 120, taxForeign: 20, pricesIncludeVat: true, imported: true },
    logs: [],
  })

  const result = await guardInvoicePaymentCapacity(client as never, { ...GUARD_PARAMS, amount: 120.02 })

  assert.equal(result.post, false)
  assert.equal(result.post === false && result.kind === 'refused' && result.ledgerTotal, 120)
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
    // The CLAIM, not the instant (o3d-550x / o3d-xl63). A caller whose claim is renewed mid-entry
    // hands in a holder that answers the CURRENT instant, so the fence follows the row rather than
    // silently matching nothing.
    claim: claimHeldFrom(claimedAt),
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

test('a renewed claim releases the row it actually holds, not the one it was picked up on', async () => {
  // The failure mode a bare `Date` hid: the remote-write lease moves `processingStartedAt` before every
  // send, so a fence built from the instant captured at pickup matches NOTHING — the retirement never
  // happens and the refusal is invisible. The holder is asked at the moment the statement is built.
  const updates: Array<{ where?: unknown }> = []
  const client = {
    accountingSyncLog: {
      updateMany: async (args: { where?: unknown }) => { updates.push(args); return { count: 1 } },
    },
  }
  let held = new Date('2026-08-20T10:00:00.000Z')
  const renewing = { heldFrom: () => held }
  held = new Date('2026-08-20T10:07:00.000Z')

  await retireOverSettlingInvoicePayment(client as never, {
    entryId: 'entry-1',
    claim: renewing,
    reason: 'would over-settle',
  })

  assert.equal((updates[0].where as { processingStartedAt: Date }).processingStartedAt.toISOString(), held.toISOString())
})

test('losing the claim fence retires nothing', async () => {
  const client = { accountingSyncLog: { updateMany: async () => ({ count: 0 }) } }
  const retired = await retireOverSettlingInvoicePayment(client as never, {
    entryId: 'entry-1',
    claim: claimHeldFrom(new Date()),
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

// ---------------------------------------------------------------------------
// o3d-anu8 — the POST-TIME half of the same rule. SYNCED is the one status this guard reads as
// "money moved", and the operator settlement action writes SYNCED from a document id a human typed.
// ---------------------------------------------------------------------------

test('[o3d-anu8] an OPERATOR-ASSERTED SYNCED registration makes the capacity unmeasurable, not favourable', () => {
  const verdict = decide({
    amount: 40,
    ledgerTotal: 100,
    registrations: [reg({
      id: 'asserted',
      status: 'SYNCED',
      // 60 + 40 = 100 exactly. Without the basis this returns post:true on a figure nothing sent.
      amount: 60,
      accountingInvoiceId: 'INV-1',
      settlementBasis: 'OPERATOR_ASSERTION',
    })],
  })
  assert.equal(verdict.post, false)
  assert.equal(verdict.post === false && verdict.refusal, 'ASSERTED_REGISTRATION')
  assert.equal(verdict.post === false && verdict.alreadyPosted, null,
    'no figure is stated, because none is known')
  assert.deepEqual(verdict.post === false && verdict.ambiguousIds, ['asserted'],
    'and the row to go and read is named')
})

test('[o3d-anu8] the same registration written back by the connector still posts', () => {
  const verdict = decide({
    amount: 40,
    ledgerTotal: 100,
    registrations: [reg({ id: 'real', status: 'SYNCED', amount: 60, accountingInvoiceId: 'INV-1', settlementBasis: null })],
  })
  assert.equal(verdict.post, true)
})
