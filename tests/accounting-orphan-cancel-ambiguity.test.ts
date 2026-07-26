import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregatePaymentSyncRows,
  effectivePaymentSyncRows,
  settlementStatus,
  type PaymentSyncRow,
} from '@/lib/domain/accounting/settlement-status'

// o3d-sref. cancelOrphanedAccountingSyncRows retires an orphaned connector's queue. It treated
// PENDING and stale PROCESSING rows identically, moving both to CANCELLED — but they are not the
// same fact:
//
//   PENDING       nothing was sent. "The ledger was never told" is TRUE.
//   PROCESSING    the claim was TAKEN, so the processor may already have made its remote call — they
//                 post BEFORE persisting SYNCED and the externalTransactionId — and then died
//                 without recording the result.
//
// CANCELLED reads as deliberately abandoned and does not block a hard delete, so a stale PROCESSING
// row became a green light: the order was deleted, the old worker's request then succeeded, and the
// external document was stranded against an order that no longer existed.
//
// WHY A FLAG AND NOT A NEW STATUS. The first attempt added an AccountingSyncStatus member. Eighteen
// code paths enumerate ['PENDING','PROCESSING','SYNCED'] (plus a partial unique index), and several
// functions switch on status without exhaustiveness — so a new member forces a correct judgement at
// every one of them and fails SILENTLY, by falling through to a success branch, wherever one is
// missed. Codex found exactly that: aggregatePaymentSyncRows had no branch for the new value and
// reported a lone unverified row as a clean "All SYNCED". A flag is inert until a site opts in, which
// makes every opt-in a deliberate, reviewable decision.

const base: PaymentSyncRow = {
  status: 'CANCELLED',
  externalTransactionId: null,
  errorMessage: 'abandoned mid-flight',
  retryCount: 1,
  amount: 100,
  paymentId: 'pay-1',
}

const unverified: PaymentSyncRow = { ...base, remoteEffectUnverified: true }

/** The preconditions decideInvoicePaymentRegistration needs before it even looks at `existing`. */
const REGISTRATION_BASE = {
  syncEnabled: true,
  accountingInvoiceId: 'INV-1',
  orderCurrency: 'GBP',
  paymentCurrency: 'GBP',
  paymentAmount: 100,
  paymentId: 'pay-new',
  bankAccountId: 'BANK-1',
  ledgerTotal: 100,
}
const provablyCancelled: PaymentSyncRow = { ...base, errorMessage: 'orphaned', retryCount: 0 }

test('an unverified row reports UNKNOWN settlement, not NOT_SENT (o3d-sref)', () => {
  // Telling an operator "the ledger was never told" invites them to re-send a payment that may
  // already be there — paying the invoice twice.
  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: unverified, totalForeign: 100,
  })

  assert.equal(verdict.status, 'LEDGER_UNMATCHED')
  assert.equal(verdict.discrepancy, true)
  assert.match(verdict.detail, /UNKNOWN/)
  assert.match(verdict.detail, /twice/, 'and it warns against the double payment')
})

test('a provably pre-call CANCELLED row still reports NOT_SENT (o3d-sref)', () => {
  // The contrast that makes the flag worth having: this one IS provable, and the old advice is right.
  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: provablyCancelled, totalForeign: 100,
  })

  assert.equal(verdict.status, 'NOT_SENT')
  assert.match(verdict.detail, /never told/)
})

test('an unverified row counts as HELD BY LEDGER when IMS shows unpaid (o3d-sref)', () => {
  const verdict = settlementStatus({
    paidLocally: false, syncEnabled: true, documentPosted: true, payment: unverified, totalForeign: 100,
  })

  assert.equal(verdict.status, 'LEDGER_UNMATCHED')
  assert.equal(verdict.discrepancy, true)
})

test('turning sync OFF does not bury an unverified row (o3d-sref)', () => {
  // `terminal` exists so disabling an unhealthy connector cannot turn a known outstanding balance
  // into a green badge. An unverified row is not a settled fact either way, so it must not qualify.
  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: false, documentPosted: true, payment: unverified, totalForeign: 100,
  })

  assert.notEqual(verdict.status, 'NOT_APPLICABLE', 'sync being off must not hide the ambiguity')
})

// ---------------------------------------------------------------------------
// THE COMPOSITION the direct settlementStatus tests did not reach. Production goes
// effectivePaymentSyncRows -> aggregatePaymentSyncRows -> settlementStatus, and the aggregation is
// where the first attempt silently produced "All SYNCED".
// ---------------------------------------------------------------------------

test('a lone unverified row survives aggregation and still reports UNKNOWN (o3d-sref)', () => {
  const effective = effectivePaymentSyncRows([unverified])
  assert.equal(effective.length, 1, 'it is not pruned as a settled non-event')

  const aggregated = aggregatePaymentSyncRows(effective)
  assert.ok(aggregated, 'aggregation must not drop it')
  assert.equal(
    aggregated?.remoteEffectUnverified,
    true,
    'the flag has to survive aggregation, or the verdict below cannot see it',
  )

  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: aggregated, totalForeign: 100,
  })
  assert.equal(verdict.status, 'LEDGER_UNMATCHED', 'reported as UNKNOWN, not as a green success')
})

test('ambiguity outranks a FAILED sibling in aggregation (o3d-sref)', () => {
  // Worst-first, and "a payment may have landed that nobody accounted for" is the worst thing in the
  // set — it is the only state where acting on the aggregate can DUPLICATE a remote payment. A FAILED
  // row would otherwise win and its spread would drop the flag, laundering the doubt away.
  const failed: PaymentSyncRow = {
    status: 'FAILED',
    externalTransactionId: null,
    errorMessage: 'rejected',
    retryCount: 3,
    amount: 100,
    paymentId: 'pay-2',
  }

  const aggregated = aggregatePaymentSyncRows(effectivePaymentSyncRows([failed, unverified]))
  assert.equal(aggregated?.remoteEffectUnverified, true, 'the flag must win over FAILED')

  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: aggregated, totalForeign: 100,
  })
  assert.equal(verdict.status, 'LEDGER_UNMATCHED', 'not LEDGER_REJECTED — rejection is not established')
})

test('an unverified row alongside SYNCED history is not a green SETTLED verdict (o3d-sref)', () => {
  // The nastier composition: with SYNCED history present, a synthetic aggregate could carry that
  // row's external id and read as fully settled — while a second payment may have landed.
  const syncedHistory: PaymentSyncRow = {
    status: 'SYNCED',
    externalTransactionId: 'PAY-001',
    errorMessage: null,
    retryCount: 0,
    amount: 40,
    paymentId: 'pay-old',
  }

  const aggregated = aggregatePaymentSyncRows(effectivePaymentSyncRows([syncedHistory, unverified]))
  assert.equal(aggregated?.remoteEffectUnverified, true, 'ambiguity wins over a SYNCED sibling')

  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: aggregated, totalForeign: 100,
  })
  assert.equal(verdict.status, 'LEDGER_UNMATCHED')
  assert.equal(verdict.discrepancy, true, 'a possibly-doubled payment is never a clean settlement')
})

test('the flag is INERT when absent — ordinary rows are unaffected (o3d-sref)', () => {
  // The property that made a flag preferable to an enum member in the first place.
  const synced: PaymentSyncRow = {
    status: 'SYNCED',
    externalTransactionId: 'PAY-002',
    errorMessage: null,
    retryCount: 0,
    amount: 100,
    paymentId: 'pay-2',
  }

  const aggregated = aggregatePaymentSyncRows(effectivePaymentSyncRows([synced]))
  assert.equal(aggregated?.status, 'SYNCED')
  assert.ok(!aggregated?.remoteEffectUnverified, 'no ambiguity invented where there is none')

  const verdict = settlementStatus({
    paidLocally: true, syncEnabled: true, documentPosted: true, payment: aggregated, totalForeign: 100,
  })
  assert.equal(verdict.discrepancy, false, 'an ordinary settled payment still reads clean')
})

// ---------------------------------------------------------------------------
// The operator path, and why it has to exist at all.
// ---------------------------------------------------------------------------

test('an unverified row is reachable by the operator retry (o3d-sref)', async () => {
  // Without this the state is a dead end: the orphan sweep produces it, the delete guard blocks on
  // it, and nothing could clear it — so an order stuck behind one would be permanently undeletable.
  const { accountingSyncRetryWhere } = await import('@/lib/domain/accounting/sync-retry-statuses')

  const clauses = JSON.stringify(accountingSyncRetryWhere('xero'))
  assert.match(clauses, /remoteEffectUnverified/, 'the unverified rows must be reachable')
  assert.match(clauses, /FAILED/, 'and the existing FAILED path is unchanged')
  assert.doesNotMatch(clauses, /SYNCED/, 'a posted document must never be re-sent by this action')

  // Scoped to one entry when asked, so an admin can resolve a single row rather than a whole queue.
  assert.match(JSON.stringify(accountingSyncRetryWhere('xero', 'entry-1')), /entry-1/)
})

test('the retry predicate lives outside the \'use server\' modules (o3d-sref)', async () => {
  // A 'use server' file may only export ASYNC functions. A plain const there compiles under tsc but
  // fails `next build` — exactly how o3d-1di reached CI earlier today. Pinned so the trap cannot be
  // re-entered by moving it back for convenience.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  for (const file of ['app/actions/xero-sync.ts', 'app/actions/quickbooks-sync.ts']) {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    assert.match(src, /^'use server'/, `${file} is a server-action module`)
    const syncExports = src.match(/^export (?!async )(?:const|function|let|var|class) /gm) ?? []
    assert.deepEqual(syncExports, [], `${file} must export only async functions, found ${syncExports}`)
  }
})

test('the follow-up dedup treats an unverified row as live, in code AND in the index (o3d-sref)', async () => {
  // THE DUPLICATE-PAYMENT PATH, and the finding that mattered most.
  //
  // Both connectors derive their remote idempotency key from the ROW ID. So if a retired
  // possibly-sent row does not block a repeated follow-up enqueue, the replacement row has a NEW id
  // and therefore a NEW key — and registers a SECOND payment even though the original may have
  // succeeded. The database's partial unique index must carry the same predicate, or the code check
  // is only advisory under concurrency.
  //
  // This hazard PREDATES the flag: a plain CANCELLED row has always been re-enqueueable this way. It
  // is closed here because the flag is the first thing that makes the case identifiable.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { readdirSync } = await import('node:fs')

  for (const file of [
    'lib/connectors/xero/sync-processor.ts',
    'lib/connectors/quickbooks/sync-processor.ts',
  ]) {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    // The existence check must consider the flag, not just the three live statuses.
    assert.match(
      src,
      /\{ remoteEffectUnverified: true \}/,
      `${file}'s follow-up existence check must treat an unverified row as live`,
    )
  }

  // And the index predicate, which is what actually enforces it.
  const migrations = join(process.cwd(), 'prisma/migrations')
  const withIndex = readdirSync(migrations)
    .filter((dir) => {
      try {
        return readFileSync(join(migrations, dir, 'migration.sql'), 'utf8')
          .includes('accounting_sync_logs_followup_live_unique')
      } catch { return false }
    })
    .sort()

  assert.ok(withIndex.length > 0, 'the follow-up unique index must exist')
  const newest = readFileSync(join(migrations, withIndex[withIndex.length - 1], 'migration.sql'), 'utf8')
  assert.match(
    newest,
    /"remoteEffectUnverified" = true/,
    'the LATEST definition of the index must include the flag, or the DB disagrees with the code',
  )
})

test('an unverified row blocks a SECOND registration for the same invoice (o3d-sref)', async () => {
  // The registration-side duplicate guard. An unverified row may already have registered its payment,
  // so it is an OBSTACLE, not an absence — excluding it would let a second registration queue for the
  // same receipt and pay the invoice twice.
  const { decideInvoicePaymentRegistration } = await import(
    '@/lib/domain/accounting/invoice-payment-registration'
  )

  const decision = decideInvoicePaymentRegistration({
    ...REGISTRATION_BASE,
    existing: [
      // A DIFFERENT receipt's row, retired mid-flight: it may already be in the ledger.
      { status: 'CANCELLED', amount: 100, paymentId: 'pay-old', remoteEffectUnverified: true },
    ],
  })

  assert.equal(decision.register, false, 'a possibly-registered payment must block a second one')
})

test('a provably pre-call CANCELLED row does NOT block a registration (o3d-sref)', async () => {
  // The contrast: nothing was sent, so it is genuinely an absence and must not stand in the way.
  const { decideInvoicePaymentRegistration } = await import(
    '@/lib/domain/accounting/invoice-payment-registration'
  )

  const decision = decideInvoicePaymentRegistration({
    ...REGISTRATION_BASE,
    existing: [{ status: 'CANCELLED', amount: 100, paymentId: 'pay-old' }],
  })

  assert.equal(decision.register, true, 'an abandoned pre-call row is not an obstacle')
})
