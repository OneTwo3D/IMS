import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A hand-entered Xero payment whose figure IMS cannot read, on an invoice IMS has never sent a payment to.
 *
 * The first post of a receipt is refused at the fence (nothing to compare the unreadable record with). That refusal must
 * leave the receipt's own row where an operator ledger check can be recorded against it and the next attempt can read it;
 * and the refusal itself must say what lifts it, rather than a bare "could not establish what the connector holds".
 */

type XeroAnswer = { data: unknown; tenantId?: string | null; connectionGeneration?: string | null }
let xeroAnswer: XeroAnswer
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, status: 200, data: xeroAnswer.data, tenantId: xeroAnswer.tenantId ?? undefined, connectionGeneration: xeroAnswer.connectionGeneration }),
  },
})

const PAYLOAD = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', amount: 60, currency: 'GBP', paymentDate: '2026-08-09', paymentId: 'pay-new' }
const UNREADABLE_HAND_PAYMENT = { PaymentID: 'PAY-H', Date: '2026-08-02', Amount: 40.005 }
const BOUND = { tenantId: 'tenant-A', connectionGeneration: 'gen-1' }
const H_AS_SHOWN = { id: 'PAY-H', amount: null, unreadableAmount: '40.005', date: '2026-08-02', reference: null }

type Row = { id: string; remoteAttemptedAt: Date | null; payload: unknown }
function fenceDb(rows: Row[]) {
  return {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: { id: string; remoteAttemptedAt: null }; data: { remoteAttemptedAt: Date } }) => {
        const row = rows.find((r) => r.id === where.id && r.remoteAttemptedAt === null)
        if (!row) return { count: 0 }
        row.remoteAttemptedAt = data.remoteAttemptedAt
        return { count: 1 }
      },
      findMany: async ({ where }: { where: { id: { not: string } } }) =>
        rows.filter((r) => r.remoteAttemptedAt !== null && r.id !== where.id.not).map((r) => ({ id: r.id, payload: r.payload })),
    },
  }
}

async function post(rows: Row[], loader?: (scope: unknown) => Promise<unknown[]>) {
  const { authoriseMoneyPost } = await import('@/lib/connectors/accounting-settlement-probe')
  return authoriseMoneyPost({
    connector: 'xero', entryId: 'log-n', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1',
    payload: PAYLOAD, postingDate: '2026-08-09', db: fenceDb(rows) as never,
    ...(loader ? { loadOperatorLedgerChecks: loader as never } : {}),
  })
}

test('the first post of a receipt beside an unreadable hand-entered payment is refused, naming what lifts it', async () => {
  xeroAnswer = { data: { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 60, AmountPaid: 40, Payments: [UNREADABLE_HAND_PAYMENT] }] }, ...BOUND }
  const rows: Row[] = [{ id: 'log-n', remoteAttemptedAt: null, payload: PAYLOAD }]
  const verdict = await post(rows)
  assert.equal(verdict.proceed, false)
  const error = verdict.proceed ? '' : verdict.error
  assert.match(error, /WHAT LIFTS THIS HOLD: open payment PAY-H on document INV-1/)
  assert.match(error, /Checked the ledger/)
})

test('after that refusal, a check recorded against the receipt\'s own row lets the next attempt proceed', async () => {
  xeroAnswer = { data: { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: 100, AmountDue: 60, AmountPaid: 40, Payments: [UNREADABLE_HAND_PAYMENT] }] }, ...BOUND }
  const { settlementRecordFingerprint } = await import('@/lib/domain/accounting/operator-ledger-check')
  const check = {
    id: 'chk-1', syncLogId: 'log-n', paymentId: 'pay-new', connector: 'xero', ledgerDocumentId: 'INV-1',
    ledgerRecordIds: ['PAY-H'], tenantId: 'tenant-A', connectionGeneration: 'gen-1',
    ledgerRecordFingerprints: [settlementRecordFingerprint(H_AS_SHOWN)],
  }
  const rows: Row[] = [{ id: 'log-n', remoteAttemptedAt: null, payload: PAYLOAD }]
  assert.equal((await post(rows)).proceed, false)
  const scopes: unknown[] = []
  const second = await post(rows, async (scope) => { scopes.push(scope); return [check] })
  assert.deepEqual(second, { proceed: true, requireConnection: BOUND })
  assert.deepEqual(scopes, [{ attemptSyncLogId: 'log-n', paymentId: 'pay-new', connector: 'xero', ledgerDocumentId: 'INV-1' }])
})
