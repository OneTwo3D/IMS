import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  decideInvoicePaymentRegistration,
  invoicePaymentRowSetBlocker,
  unresolvedInvoicePaymentAttempts,
  type ExistingInvoicePaymentSync,
} from '@/lib/domain/accounting/invoice-payment-registration'
import type { LedgerSettlementRecord } from '@/lib/domain/accounting/ledger-settlement-evidence'

/**
 * o3d-lgo.15, decision recorded 2026-07-25: a manually-recorded sales receipt DOES register against the
 * ledger invoice, on the same principle as markBillPaid — but guarded, because the ledger may already
 * know about the money and a payment registered twice has to be reversed there by hand.
 *
 * Every refusal below leaves the receipt recorded and the settlement verdict visibly unsettled. That is
 * the safe end of the trade: someone can act on a warning, but nobody goes looking for a duplicate
 * payment they were never told about.
 */

const base = {
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentAmount: 100,
  paymentId: 'pay-new',
  bankAccountId: 'BANK-1',
  existing: [] as ExistingInvoicePaymentSync[],
  // Most cases have no unresolved attempt, so the ledger is never consulted and this is unread.
  // The cases that DO have one pass their own records — see the o3d-0m56 block at the end.
  ledgerSettlements: null as LedgerSettlementRecord[] | null,
  ledgerTotal: 100,
}

test('a receipt against a posted invoice with a mapped bank account is registered', () => {
  const d = decideInvoicePaymentRegistration(base)
  assert.equal(d.register, true)
  assert.equal(d.register && d.bankAccountId, 'BANK-1')
})

test('nothing is registered while the connector is off', () => {
  const d = decideInvoicePaymentRegistration({ ...base, syncEnabled: false })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'SYNC_DISABLED')
})

test('a payment cannot attach to an invoice the ledger has never seen', () => {
  const d = decideInvoicePaymentRegistration({ ...base, accountingInvoiceId: null })
  assert.equal(d.register === false && d.refusal, 'DOCUMENT_NOT_POSTED')
})

test('a receipt in another currency is not registered against the invoice', () => {
  const d = decideInvoicePaymentRegistration({ ...base, paymentCurrency: 'EUR' })
  assert.equal(d.register === false && d.refusal, 'CURRENCY_MISMATCH')
})

test('an unmapped payment method is refused rather than guessed at', () => {
  const d = decideInvoicePaymentRegistration({ ...base, bankAccountId: null })
  assert.equal(d.register === false && d.refusal, 'NO_BANK_ACCOUNT')
})

test('an imported order whose payment the ledger already holds is NOT paid a second time', () => {
  // THE CASE THIS GUARD EXISTS FOR. An imported paid order registers its receipt through the
  // SALES_INVOICE follow-up and creates NO local Payment row — so IMS's own payment rows do not bound
  // what the ledger has been told. An operator then recording "the" payment would double-pay it.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: 100, paymentId: null }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, 100)
  assert.equal(d.register === false && d.ledgerTotal, 100)
})

test('a SECOND receipt is refused even when it fits inside the invoice total', () => {
  // Not a policy invented here: accounting_sync_logs_followup_live_unique permits ONE live
  // INVOICE_PAYMENT per order, so queueing a second violates the constraint. Refusing it visibly beats
  // letting the insert throw and turning a receipt the operator believed recorded into an error log.
  const d = decideInvoicePaymentRegistration({
    ...base,
    paymentAmount: 60,
    existing: [{ status: 'SYNCED', amount: 40, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, 40)
})

test('a payment still in the queue holds the slot as firmly as a synced one', () => {
  // PENDING is not "not sent" — it is on its way, and the unique index counts it.
  for (const status of ['PENDING', 'PROCESSING'] as const) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [{ status, amount: 100, paymentId: 'pay-old' }] })
    assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT', status)
  }
})

test('a rejected or cancelled payment frees the DATABASE slot, but only the ledger frees the decision', () => {
  // This test used to assert `register: true` outright, on the reading that a FAILED or CANCELLED row
  // "holds nothing". The partial unique index does ignore those statuses — but the index is a statement
  // about rows, not about money. A call that COMMITTED and then lost its response is FAILED, and
  // deleting a receipt CANCELS a row that may already have settled (o3d-0m56, Codex review). So the
  // slot is free and the decision is not, until the ledger says the earlier attempt is not in it.
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const existing = [{ status, amount: 100, paymentDate: '2026-08-01', paymentId: 'pay-old' }]
    assert.equal(
      decideInvoicePaymentRegistration({ ...base, existing, ledgerSettlements: [] }).register,
      true,
      `${status}: a ledger with no matching settlement is what makes this safe`,
    )
    const blocked = decideInvoicePaymentRegistration({ ...base, existing, ledgerSettlements: null })
    assert.equal(blocked.register === false && blocked.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT',
      `${status}: an unanswered ledger is not permission`)
  }
})

test('a live row with no recorded amount still blocks, and says nothing about how much', () => {
  // The slot is taken whether or not the amount is readable — so this fails closed by construction. The
  // operator message must not invent a figure it does not have.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'SYNCED', amount: null, paymentId: 'pay-old' }],
  })
  assert.equal(d.register === false && d.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(d.register === false && d.alreadyRegistered, undefined)
})

test('an unreadable amount on a rejected row no longer waves the receipt through', () => {
  // This asserted `register: true` on the reading that "a rejected row holds nothing". It can hold a
  // payment — the response may simply have been lost — and with no amount recorded, no settlement in
  // the ledger can ever be matched to it, so it can never be ruled out (o3d-0m56). It does NOT take the
  // database's live slot, though, so the refusal names the unresolved attempt rather than a live one.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'FAILED', amount: null, paymentId: 'pay-old' }],
    ledgerSettlements: [],
  })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
})

test('this receipt does not count against itself when the decision is re-run', () => {
  // The idempotency key already makes a second queue a no-op, so treating our own row as the slot-taker
  // would refuse the retry for its own success.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-new' }],
  })
  assert.equal(d.register, true)
})

test('an imported tax-inclusive invoice is measured against what the ledger holds, not the gross total', () => {
  // The caller passes ledgerTotal from ledgerSalesInvoiceTotalForeign: an IMPORTED tax-inclusive invoice
  // posts at NET (o3d-cyn), so a gross receipt against it would EXCEED the invoice and Xero would reject
  // it. Refusing here turns a rejected sync into a warning that names the number. An order raised in IMS
  // posts at gross and is unaffected.
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 120, ledgerTotal: 100 })
  assert.equal(d.register === false && d.refusal, 'WOULD_OVERPAY')
})

test('sub-penny rounding does not refuse an exact settlement', () => {
  const d = decideInvoicePaymentRegistration({ ...base, paymentAmount: 100.004, ledgerTotal: 100 })
  assert.equal(d.register, true)
})

// --- o3d-0m56: the OTHER way a second payment reaches the ledger (Codex finding 2) ---

/**
 * The manual-retry guard protects the RETRY of a failed payment row. Nothing was protecting the
 * likelier operator action: record the receipt again. That queues a BRAND-NEW row under a NEW
 * idempotency token, so it posts a second payment against the same invoice without the retry
 * guard ever running — and a failed payment looks, from the order screen, like nothing happened.
 */

const unresolved = (over: Partial<ExistingInvoicePaymentSync> = {}): ExistingInvoicePaymentSync => ({
  status: 'FAILED', amount: 100, paymentDate: '2026-08-01', paymentId: 'pay-old', ...over,
})

test('a receipt beside an unresolved attempt the ledger HOLDS is refused (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-08-01', id: 'PAY-1' }],
  })
  assert.equal(d.register, false)
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(String(d.register === false ? d.detail : ''), /already holds 100\.00 dated 2026-08-01/)
})

test('a ledger that cannot be asked refuses too (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({ ...base, existing: [unresolved()], ledgerSettlements: null })
  assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')
  assert.match(String(d.register === false ? d.detail : ''), /could not be asked/)
})

test('an unresolved attempt IMS cannot describe refuses (o3d-0m56)', () => {
  // No amount or no date means no settlement in the ledger can be matched to it, so it can never
  // be ruled out. Refusing is the only honest answer.
  for (const attempt of [unresolved({ amount: null }), unresolved({ paymentDate: null })]) {
    const d = decideInvoicePaymentRegistration({ ...base, existing: [attempt], ledgerSettlements: [] })
    assert.equal(d.register === false && d.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT', JSON.stringify(attempt))
  }
})

test('an attempt that PROVABLY never posted does not block the receipt (o3d-0m56)', () => {
  // The stranding direction has a cost, so it is kept as narrow as the retry guard's: a stored body
  // missing a field the connector requires was rejected before any HTTP call, so it carries nothing.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved({ couldHaveReachedLedger: false })],
    ledgerSettlements: null,
  })
  assert.equal(d.register, true)
})

test('our OWN failed row does not block this receipt (o3d-0m56)', () => {
  // Re-running the registration for the same Payment must not refuse for its own earlier failure —
  // it re-posts under the same token, which is the case the whole idempotency scheme is built on.
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved({ paymentId: 'pay-new' })],
    ledgerSettlements: null,
  })
  assert.equal(d.register, true)
})

test('a settlement for a different amount or date leaves the receipt free (o3d-0m56)', () => {
  const d = decideInvoicePaymentRegistration({
    ...base,
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-07-01' }, { amount: 40, date: '2026-08-01' }],
  })
  assert.equal(d.register, true, 'only a settlement matching the ATTEMPT is evidence about it')
})

test('the caller can tell whether the ledger needs asking at all (o3d-0m56)', () => {
  // The probe is a network read; putting one behind every receipt would be a new problem. This is
  // the rule the caller uses to decide, so it is pinned here rather than left implicit in sales.ts.
  assert.deepEqual(unresolvedInvoicePaymentAttempts([], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([{ status: 'SYNCED', amount: 100 }], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([unresolved({ paymentId: 'pay-new' })], 'pay-new'), [])
  assert.deepEqual(unresolvedInvoicePaymentAttempts([unresolved({ couldHaveReachedLedger: false })], 'pay-new'), [])
  assert.equal(unresolvedInvoicePaymentAttempts([unresolved(), unresolved({ status: 'CANCELLED' })], 'pay-new').length, 2)
})

test('sales.ts asks the ledger exactly when the decision needs it (o3d-0m56)', async () => {
  // registerInvoicePaymentWithLedger is module-private, so this pins the WIRING the pure tests
  // above cannot reach: the probe is gated on there being an unresolved attempt, its failure
  // becomes null rather than an empty list, and the result is what the decision is given.
  const source = await readFile(path.join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  const at = source.indexOf('const ledgerSettlements =')
  assert.notEqual(at, -1, 'the registration path must resolve what the ledger holds')
  const body = source.slice(at, source.indexOf('const decision = decideInvoicePaymentRegistration', at))

  assert.match(body, /unresolvedInvoicePaymentAttempts\(existing, params\.paymentId\)\.length > 0/,
    'the probe must be gated on an unresolved attempt, not run on every receipt')
  assert.match(body, /probe\.ok \? probe\.records : null/,
    'a probe that could not answer must become null — the value the decision refuses on')
  assert.match(source.slice(at), /ledgerSettlements,/, 'and it must reach the decision')

  // The two fields the unresolved rule is decided from must actually be read off the stored row.
  // Without paymentDate no attempt can ever be matched, so every receipt beside a failed row is
  // refused; without the postability flag, a row that provably never posted strands one.
  const loader = source.slice(source.indexOf('async function loadInvoicePaymentSyncRows'))
  const loaderBody = loader.slice(0, loader.indexOf('\n}\n'))
  // Round 6, finding 1: carried from the SHARED date rule, not from a local copy of
  // `payload.paymentDate?.slice(0, 10)`. A copy here is a copy that can drift from what the
  // processor will actually send, which is how the probe came to look for settlements on days no
  // post would ever create.
  assert.match(loaderBody, /paymentDate: pinnedAttemptDate\('INVOICE_PAYMENT', r\.payload\)/,
    'the attempt date must be carried from the shared money-post date rule')
  assert.match(loaderBody, /couldHaveReachedLedger: attemptCouldHaveReachedTheLedger\('INVOICE_PAYMENT', r\.payload\)/,
    'and postability judged by the SAME rule the retry guard uses')

  // The refusal has to be surfaced, not swallowed: an operator who is not told will record the
  // receipt again.
  assert.match(source, /case 'UNRESOLVED_PAYMENT_ATTEMPT':/)
  const warn = source.slice(source.indexOf("case 'UNRESOLVED_PAYMENT_ATTEMPT':"))
  assert.match(warn.slice(0, 900), /invoice_payment_not_registered/)
  assert.match(warn.slice(0, 900), /could pay the invoice twice/)
})

test('the BILL side is closed by a different mechanism, and it must stay closed (o3d-0m56)', async () => {
  // Codex's finding 2 is about re-recording a receipt beside an unresolved attempt. The supplier
  // side has the same shape and no equivalent guard — because markBillPaid is single-shot: it only
  // writes paidAt while paidAt IS NULL, and the only thing that clears paidAt again is a payment
  // poller finding the bill genuinely unpaid in the ledger. A committed-but-unacknowledged bill
  // payment therefore leaves the ledger showing PAID, and the second attempt is refused before it
  // reaches the queue.
  //
  // That argument depends entirely on the compare-and-set below, so it is pinned here rather than
  // left as a comment: if the fence goes, BILL_PAYMENT needs the unresolved-attempt check too.
  const source = await readFile(path.join(process.cwd(), 'app/actions/purchase-orders.ts'), 'utf8')
  const at = source.indexOf('const paidUpdate = await db.purchaseInvoice.updateMany')
  assert.notEqual(at, -1, 'markBillPaid must still write paidAt conditionally')
  assert.match(source.slice(at, at + 200), /where: \{ id: invoiceId, paidAt: null \}/,
    'a bill may only be marked paid while it is unpaid')
  assert.match(source.slice(0, at), /if \(invoice\.paidAt\) return \{ success: false/,
    'and the early refusal must stay too')
})

test('the row-set rules are re-runnable on their own, for the check inside the write (o3d-0m56)', () => {
  // Codex round 2. The decision above is taken against a row snapshot and a ledger reading that both
  // predate the transaction that writes. Between them another registration can be queued, or an
  // earlier attempt can turn unresolved — so the row-set half of the rule runs AGAIN inside that
  // transaction, under the scope lock. It is the same code, not a second copy of the rule.
  assert.deepEqual(
    invoicePaymentRowSetBlocker({ paymentId: 'pay-new', existing: [], ledgerSettlements: null }),
    { blocked: false },
  )
  const live = invoicePaymentRowSetBlocker({
    paymentId: 'pay-new',
    existing: [{ status: 'PENDING', amount: 100, paymentId: 'pay-other' }],
    ledgerSettlements: null,
  })
  assert.equal(live.blocked && live.refusal, 'LEDGER_HAS_LIVE_PAYMENT')
  assert.equal(live.blocked && live.alreadyRegistered, 100)

  const unresolvedNow = invoicePaymentRowSetBlocker({
    paymentId: 'pay-new',
    existing: [unresolved()],
    ledgerSettlements: [{ amount: 100, date: '2026-08-01' }],
  })
  assert.equal(unresolvedNow.blocked && unresolvedNow.refusal, 'UNRESOLVED_PAYMENT_ATTEMPT')

  // It must NOT judge size: the caller inside the transaction has the row set and nothing else, and
  // a re-run that refused on amount would refuse every receipt.
  assert.deepEqual(
    invoicePaymentRowSetBlocker({ paymentId: 'pay-new', existing: [], ledgerSettlements: [] }),
    { blocked: false },
  )
})

test('sales.ts re-checks the row set INSIDE the write transaction, under the scope lock (o3d-0m56)', async () => {
  // Wiring, pinned by source because registerInvoicePaymentWithLedger is module-private: the point
  // is not that the rule exists but that it is evaluated again in the transaction that writes.
  const source = await readFile(path.join(process.cwd(), 'app/actions/sales.ts'), 'utf8')
  // Anchored INSIDE registerInvoicePaymentWithLedger: `db.$transaction(async (tx) =>` appears many
  // times in this file, and the first one belongs to order deletion.
  const fnAt = source.indexOf('async function registerInvoicePaymentWithLedger')
  assert.notEqual(fnAt, -1, 'the registration path must still exist')
  const at = source.indexOf('const outcome = await db.$transaction(async (tx) => {', fnAt)
  assert.notEqual(at, -1)
  const body = source.slice(at, source.indexOf('}, STOCK_TX_OPTIONS)', at))

  const lockAt = body.indexOf('await lockFollowUpScope(tx, {')
  const readAt = body.indexOf('loadInvoicePaymentSyncRows(params.orderId, probeConnector, tx)')
  const checkAt = body.indexOf('invoicePaymentRowSetBlocker({')
  const queueAt = body.indexOf('queueAccountingSyncTx(tx, {')
  assert.ok(lockAt !== -1, 'the scope lock must be taken inside the transaction')
  assert.ok(readAt > lockAt, 'the rows must be re-read UNDER the lock, not before it')
  assert.ok(checkAt > readAt && queueAt > checkAt, 'and re-judged before the write')
  assert.match(body.slice(checkAt, checkAt + 400), /if \(blocker\.blocked\) \{[\s\S]*?return \{ outcome: 'context-changed-guard'/,
    'a blocked re-check must abandon the enqueue')

  // The ledger is deliberately NOT re-read here — a network call inside the lock would let a slow
  // remote block every payment enqueue in the system.
  assert.ok(!/probeLedgerSettlement/.test(body), 'no network call inside the locked transaction')
})
