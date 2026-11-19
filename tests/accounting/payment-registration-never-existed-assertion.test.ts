import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-5fx28 (owner decision 2026-11-18): an ADMIN may assert that a retired (unstamped CANCELLED) payment registration never existed in
// the ledger. The assertion is audited (who, when, why) in the same transaction, and clears the receipt block for that row class only.
// No database, no network: the transaction is a double.

const locked: string[] = []
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async (_tx: unknown, id: string) => { locked.push(id) } } })

type Row = {
  id: string; connector: string; type: string; referenceType: string; referenceId: string; status: string
  externalTransactionId: string | null; settlementBasis: string | null; abandonedBeforeRemoteCall: boolean | null; errorMessage: string | null
  attemptRevision: number; remoteAttemptedAt: Date | null; attemptStampingCustodyAt: Date | null
}
const baseRow = (over: Partial<Row> = {}): Row => ({
  id: 'sync-1', connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', status: 'CANCELLED',
  externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null, errorMessage: 'Retired: legacy', attemptRevision: 1, remoteAttemptedAt: null, attemptStampingCustodyAt: null, ...over,
})

function fakeTx(row: Row | null, opts: { moveBeforeUpdate?: boolean } = {}) {
  const audit: Array<Record<string, unknown>> = []
  const tx = {
    accountingSyncLog: {
      findUnique: async () => (row ? { ...row } : null),
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (!row || opts.moveBeforeUpdate) return { count: 0 }
        Object.assign(row, args.data)
        return { count: 1 }
      },
    },
    activityLog: { create: async (args: { data: Record<string, unknown> }) => { audit.push(args.data); return args.data } },
  }
  return { tx: tx as never, audit }
}

const NOW = new Date('2026-11-18T12:00:00.000Z')
const input = { syncLogId: 'sync-1', orderId: 'order-1', reason: 'Checked the invoice in Xero: no payment was ever registered', actorUserId: 'admin-1', now: NOW }

test('the unstamped CANCELLED registration reads UNDECIDED (the block) until an admin asserts it never existed; then it reads NOTHING and the delete split frees the receipt', async () => {
  const { splitPaymentRegistrations, registrationLedgerStanding } = await import('@/lib/domain/accounting/payment-ledger-hold')
  const { assertPaymentRegistrationNeverExisted } = await import('@/lib/domain/accounting/payment-registration-assertion')
  const row = baseRow()
  const asRegistration = () => ({ id: row.id, connector: row.connector, status: row.status, externalTransactionId: row.externalTransactionId, settlementBasis: row.settlementBasis, abandonedBeforeRemoteCall: row.abandonedBeforeRemoteCall, attemptRevision: row.attemptRevision, remoteAttemptedAt: row.remoteAttemptedAt, attemptStampingCustodyAt: row.attemptStampingCustodyAt })
  assert.equal(registrationLedgerStanding(asRegistration()), 'UNDECIDED')
  assert.equal(splitPaymentRegistrations([asRegistration()]).undecided.length, 1, 'blocked before')

  const { tx, audit } = fakeTx(row)
  await assertPaymentRegistrationNeverExisted(tx, input)
  assert.deepEqual(locked.at(-1), 'order-1', 'taken under the order lock')
  assert.equal(registrationLedgerStanding(asRegistration()), 'NOTHING')
  const split = splitPaymentRegistrations([asRegistration()])
  assert.equal(split.undecided.length, 0, 'the block is cleared')
  assert.equal(split.ledgerHold.length, 0)
  assert.match(String(row.errorMessage), /never existed/)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].action, 'payment_registration_never_existed_asserted')
  assert.equal(audit[0].userId, 'admin-1')
  assert.equal(audit[0].level, 'WARNING')
  const meta = audit[0].metadata as Record<string, unknown>
  assert.equal(meta.settlementBasis, 'OPERATOR_ASSERTION')
  assert.equal(meta.assertedAt, NOW.toISOString())
  assert.match(String(meta.reason), /no payment was ever registered/)
})

test('a reason is required, and nothing is written without one', async () => {
  const { assertPaymentRegistrationNeverExisted, PaymentRegistrationAssertionRefused } = await import('@/lib/domain/accounting/payment-registration-assertion')
  const row = baseRow()
  const { tx, audit } = fakeTx(row)
  await assert.rejects(() => assertPaymentRegistrationNeverExisted(tx, { ...input, reason: ' short ' }), (e: unknown) => e instanceof PaymentRegistrationAssertionRefused && e.code === 'reason_required')
  assert.equal(audit.length, 0)
  assert.equal(row.abandonedBeforeRemoteCall, null)
})

test('only the unstamped CANCELLED class is assertable: a row with a payment id, an earlier operator decision, a pre-call stamp, or another status is refused untouched', async () => {
  const { assertPaymentRegistrationNeverExisted, PaymentRegistrationAssertionRefused } = await import('@/lib/domain/accounting/payment-registration-assertion')
  const cases: Array<[string, Partial<Row>]> = [
    ['carries a payment id', { externalTransactionId: 'PAY-1' }],
    ['operator-settled (OPERATOR_ASSERTION)', { settlementBasis: 'OPERATOR_ASSERTION' }],
    ['already stamped pre-call', { abandonedBeforeRemoteCall: true }],
    ['FAILED', { status: 'FAILED' }],
    ['PENDING', { status: 'PENDING' }],
    ['another document type', { type: 'INVOICE' }],
    ['another order', { referenceId: 'order-2' }],
  ]
  for (const [name, over] of cases) {
    const row = baseRow(over)
    const before = JSON.stringify(row)
    const { tx, audit } = fakeTx(row)
    await assert.rejects(() => assertPaymentRegistrationNeverExisted(tx, input), (e: unknown) => e instanceof PaymentRegistrationAssertionRefused && e.code === 'not_in_class', name)
    assert.equal(JSON.stringify(row), before, `${name}: row untouched`)
    assert.equal(audit.length, 0, `${name}: no audit`)
  }
})

test('a row that moves between the read and the stamp makes the assertion refuse (the transaction rolls back the audit row with it)', async () => {
  const { assertPaymentRegistrationNeverExisted, PaymentRegistrationAssertionRefused } = await import('@/lib/domain/accounting/payment-registration-assertion')
  const { tx } = fakeTx(baseRow(), { moveBeforeUpdate: true })
  await assert.rejects(() => assertPaymentRegistrationNeverExisted(tx, input), (e: unknown) => e instanceof PaymentRegistrationAssertionRefused && e.code === 'row_moved')
})

test('the action is ADMIN-only and needs a fresh session: a non-admin is refused before anything is read', async () => {
  let dbTouched = false
  mock.module('@/lib/auth/server', {
    namedExports: {
      requireFreshAdmin: async () => { throw new Error('Forbidden: requires role ADMIN') },
      freshAuthFailureResult: () => null,
    },
  })
  mock.module('@/lib/db', { namedExports: { db: { $transaction: async () => { dbTouched = true } } } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
  const { assertPaymentRegistrationNeverExistedAction } = await import('@/app/actions/payment-registration-assertion')
  await assert.rejects(() => assertPaymentRegistrationNeverExistedAction('sync-1', 'order-1', input.reason), /requires role ADMIN/)
  assert.equal(dbTouched, false)
})
