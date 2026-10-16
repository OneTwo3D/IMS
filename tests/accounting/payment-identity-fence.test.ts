import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * DIFFERENT PAYMENTS ON ONE INVOICE BOTH POST; THE SAME PAYMENT NEVER DOES (the money-post fence).
 *
 * A deposit and a balance are two Xero payments against one invoice. The fence used to judge every
 * previously-attempted row on the document by its own mark, so a deposit that had posted was found by
 * its mark in Xero and the balance was refused as "would pay it twice". It now asks the one partition
 * (lib/domain/accounting/payment-identity.ts): a rival PROVEN to be a different payment never refuses by
 * its own verdict, and its ledger records are attributed to it by MARK and set aside.
 *
 * The probe is real (`probeLedgerSettlement` -> `probeXeroSettlement`); only the Xero transport is replaced.
 * Every MUST-REFUSE row is the duplicate matrix (D*), every MUST-PASS row the different-payment one (P*).
 */

let xeroAnswer: { ok: boolean; data?: unknown } = { ok: true }
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: xeroAnswer.ok, status: xeroAnswer.ok ? 200 : 500, data: xeroAnswer.data, error: xeroAnswer.ok ? undefined : 'down' }),
  },
})

const probeModule = async () => import('@/lib/connectors/accounting-settlement-probe')

const ORDER = 'so-1'
const base = { accountingInvoiceId: 'INV-1', bankAccountId: 'BANK-1', currency: 'GBP' }
const DEP = { ...base, amount: 40, paymentDate: '2026-08-02', paymentId: 'pay-dep' }
const BAL = { ...base, amount: 60, paymentDate: '2026-08-09', paymentId: 'pay-bal' }
const HALF_DEP = { ...base, amount: 50, paymentDate: '2026-08-02', paymentId: 'pay-dep' }
const HALF_BAL = { ...base, amount: 50, paymentDate: '2026-08-02', paymentId: 'pay-bal' }

type Row = { id: string; remoteAttemptedAt: Date | null; payload: unknown }
const sent = new Date('2026-08-02T10:00:00Z')

function fenceDb(rows: Row[], receipts: Array<{ id: string; orderId: string; refundId: string | null }>) {
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
    payment: {
      findMany: async ({ where }: { where: { orderId: string; refundId: null } }) =>
        receipts.filter((r) => r.orderId === where.orderId && r.refundId === where.refundId),
    },
  }
}

const RECEIPTS = [
  { id: 'pay-dep', orderId: ORDER, refundId: null },
  { id: 'pay-bal', orderId: ORDER, refundId: null },
]

async function marker(id: string, payload: unknown) {
  const { settlementMarkerFor } = await import('@/lib/domain/accounting/ledger-settlement-evidence')
  const { effectiveTokenFor } = await import('@/lib/domain/accounting/followup-retry-guard')
  return settlementMarkerFor(effectiveTokenFor('xero', { id, payload }))
}

function invoice(total: number, payments: unknown[]) {
  const paid = payments.reduce<number>((s, p) => s + Number((p as { Amount: number }).Amount), 0)
  return { Invoices: [{ InvoiceID: 'INV-1', CurrencyCode: 'GBP', Total: total, AmountDue: total - paid, AmountPaid: paid, Payments: payments }] }
}

async function post(opts: {
  target: { id: string; payload: Record<string, unknown> }
  rows: Row[]
  receipts?: Array<{ id: string; orderId: string; refundId: string | null }>
  ledger: unknown
  ledgerOk?: boolean
}) {
  const { authoriseMoneyPost } = await probeModule()
  xeroAnswer = { ok: opts.ledgerOk ?? true, data: opts.ledger }
  const rows = opts.rows.some((r) => r.id === opts.target.id) ? opts.rows : [{ id: opts.target.id, remoteAttemptedAt: null, payload: opts.target.payload }, ...opts.rows]
  return authoriseMoneyPost({
    connector: 'xero', entryId: opts.target.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: ORDER,
    payload: opts.target.payload, postingDate: String(opts.target.payload.paymentDate),
    db: fenceDb(rows, opts.receipts ?? RECEIPTS) as never,
  })
}

const verdictText = (v: { proceed: boolean; error?: string }) => (v.proceed ? 'PROCEED' : `REFUSED: ${v.error}`)

// ---------------------------------------------------------------------------------------------
// MUST PASS - different payments
// ---------------------------------------------------------------------------------------------

test('P1 a SYNCED deposit (its mark in Xero) does not stop a fresh balance receipt', async () => {
  const depMark = await marker('log-dep', DEP)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }]),
  })
  console.log(`[P1] ${verdictText(v)}`)
  assert.equal(v.proceed, true)
})

test('P2 a 50/50 split on one day: the deposit is attributed by its mark, so the balance is not "recorded outside IMS"', async () => {
  const depMark = await marker('log-dep', HALF_DEP)
  const v = await post({
    target: { id: 'log-bal', payload: HALF_BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: HALF_DEP }],
    ledger: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 50, Reference: depMark }]),
  })
  console.log(`[P2] ${verdictText(v)}`)
  assert.equal(v.proceed, true)
})

test('P3 a FAILED deposit of a live different receipt whose payment IS in the ledger: the balance proceeds, the deposit\'s own retry refuses (D1)', async () => {
  const depMark = await marker('log-dep', DEP)
  const ledger = invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }])
  const rows = (): Row[] => [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }]
  const balance = await post({ target: { id: 'log-bal', payload: BAL }, rows: rows(), ledger })
  console.log(`[P3] balance: ${verdictText(balance)}`)
  assert.equal(balance.proceed, true)
  // D1: the same row retried finds its own mark.
  const retry = await post({ target: { id: 'log-dep', payload: DEP }, rows: rows(), ledger })
  console.log(`[D1] ${verdictText(retry)}`)
  assert.equal(retry.proceed, false)
  assert.match(retry.proceed ? '' : retry.error, /would pay it twice|pay the document twice|Sending it again/)
})

test('P5/A5 the FAILED deposit is retried after the balance posted: allowed when its own mark is NOT in the ledger', async () => {
  const balMark = await marker('log-bal', BAL)
  const v = await post({
    target: { id: 'log-dep', payload: DEP },
    rows: [
      { id: 'log-dep', remoteAttemptedAt: sent, payload: DEP },
      { id: 'log-bal', remoteAttemptedAt: sent, payload: BAL },
    ],
    ledger: invoice(100, [{ PaymentID: 'PAY-BAL', Date: '2026-08-09', Amount: 60, Reference: balMark }]),
  })
  console.log(`[A5] ${verdictText(v)}`)
  assert.equal(v.proceed, true)
})

// ---------------------------------------------------------------------------------------------
// MUST REFUSE - the same payment, or a payment that cannot be shown to be a different one
// ---------------------------------------------------------------------------------------------

test('D2 the SAME receipt, a second row with a new token, beside a SYNCED first row whose mark is in the ledger: refuses', async () => {
  const firstMark = await marker('log-dep-1', DEP)
  const v = await post({
    target: { id: 'log-dep-2', payload: DEP },
    rows: [{ id: 'log-dep-1', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: firstMark }]),
  })
  console.log(`[D2] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
  assert.match(v.proceed ? '' : v.error, /log-dep-1/)
})

test('D4 the SAME receipt\'s earlier row FAILED and the ledger cannot be read: refuses as unknown', async () => {
  const v = await post({
    target: { id: 'log-dep-2', payload: DEP },
    rows: [{ id: 'log-dep-1', remoteAttemptedAt: sent, payload: DEP }],
    ledger: undefined,
    ledgerOk: false,
  })
  console.log(`[D4] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D5 a rival with NO recorded receipt (an imported registration) is possibly the same payment: refuses', async () => {
  const { paymentId: _omit, ...unattributed } = DEP
  void _omit
  const mark = await marker('log-imp', unattributed)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-imp', remoteAttemptedAt: sent, payload: unattributed }],
    ledger: invoice(100, [{ PaymentID: 'PAY-IMP', Date: '2026-08-02', Amount: 40, Reference: mark }]),
  })
  console.log(`[D5] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D6 a rival whose Payment row was DELETED (the receipt may be re-entered under a new id) still refuses', async () => {
  const depMark = await marker('log-dep', DEP)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    receipts: [{ id: 'pay-bal', orderId: ORDER, refundId: null }],
    ledger: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }]),
  })
  console.log(`[D6] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D6b a rival whose receipt belongs to ANOTHER order, or settles a credit note, is not a different payment of this invoice', async () => {
  const depMark = await marker('log-dep', DEP)
  const ledger = invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }])
  for (const receipts of [
    [{ id: 'pay-dep', orderId: 'so-OTHER', refundId: null }, { id: 'pay-bal', orderId: ORDER, refundId: null }],
    [{ id: 'pay-dep', orderId: ORDER, refundId: 'refund-1' }, { id: 'pay-bal', orderId: ORDER, refundId: null }],
  ]) {
    const v = await post({ target: { id: 'log-bal', payload: BAL }, rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }], receipts, ledger })
    assert.equal(v.proceed, false, JSON.stringify(receipts))
  }
})

test('D7 a hand-entered UNMARKED Xero payment with the same amount and date as this receipt still refuses', async () => {
  const depMark = await marker('log-dep', DEP)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(100, [
      { PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark },
      { PaymentID: 'PAY-HAND', Date: '2026-08-09', Amount: 60, Reference: 'bank ref' },
    ]),
  })
  console.log(`[D7] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D7b a hand-entered unmarked payment that matches BOTH the (never posted) deposit and this balance refuses: attribution is by mark, never by amount and date', async () => {
  const v = await post({
    target: { id: 'log-bal', payload: HALF_BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: HALF_DEP }],
    ledger: invoice(100, [{ PaymentID: 'PAY-HAND', Date: '2026-08-02', Amount: 50, Reference: 'bank ref' }]),
  })
  console.log(`[D7b] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D8 an UNMEASURABLE record that carries no different payment\'s mark refuses', async () => {
  const depMark = await marker('log-dep', DEP)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(100, [
      { PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark },
      { PaymentID: 'PAY-H', Date: '2026-08-05', Amount: 20.005 },
    ]),
  })
  console.log(`[D8] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D9 a different payment\'s mark on TWO records is a duplicate already on the ledger: refuses', async () => {
  const depMark = await marker('log-dep', DEP)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(120, [
      { PaymentID: 'PAY-DEP-1', Date: '2026-08-02', Amount: 40, Reference: depMark },
      { PaymentID: 'PAY-DEP-2', Date: '2026-08-03', Amount: 40, Reference: depMark },
    ]),
  })
  console.log(`[D9] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D9b a record that carries BOTH this row\'s mark and a different payment\'s is never set aside', async () => {
  const depMark = await marker('log-dep', DEP)
  const ownMark = await marker('log-bal', BAL)
  const v = await post({
    target: { id: 'log-bal', payload: BAL },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }, { id: 'log-bal', remoteAttemptedAt: sent, payload: BAL }],
    ledger: invoice(100, [{ PaymentID: 'PAY-X', Date: '2026-08-02', Amount: 40, Reference: `${depMark} ${ownMark}` }]),
  })
  console.log(`[D9b] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('D10 the same receipt raised again against a re-raised invoice (another scope) is possibly the same payment: refuses', async () => {
  const mark = await marker('log-old', { ...DEP, accountingInvoiceId: 'INV-1' })
  const v = await post({
    target: { id: 'log-new', payload: DEP },
    rows: [{ id: 'log-old', remoteAttemptedAt: sent, payload: { ...DEP, accountingInvoiceId: 'INV-1' } }],
    ledger: invoice(100, [{ PaymentID: 'PAY-OLD', Date: '2026-08-02', Amount: 40, Reference: mark }]),
  })
  console.log(`[D10] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('M10 an undescribable attempt reads the UNFILTERED ledger: a payment attributed to another receipt still counts as "the ledger holds something"', async () => {
  const depMark = await marker('log-dep', DEP)
  const { amount: _amount, ...noAmount } = BAL
  void _amount
  const v = await post({
    target: { id: 'log-bal', payload: noAmount },
    rows: [{ id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }],
    ledger: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }]),
  })
  console.log(`[M10] ${verdictText(v)}`)
  assert.equal(v.proceed, false)
})

test('the identity read is fail-closed: a receipt read that throws leaves every rival "possibly the same"', async () => {
  const depMark = await marker('log-dep', DEP)
  const { authoriseMoneyPost } = await probeModule()
  xeroAnswer = { ok: true, data: invoice(100, [{ PaymentID: 'PAY-DEP', Date: '2026-08-02', Amount: 40, Reference: depMark }]) }
  const rows: Row[] = [{ id: 'log-bal', remoteAttemptedAt: null, payload: BAL }, { id: 'log-dep', remoteAttemptedAt: sent, payload: DEP }]
  const db = fenceDb(rows, RECEIPTS)
  db.payment.findMany = async () => { throw new Error('receipts unreadable') }
  const v = await authoriseMoneyPost({
    connector: 'xero', entryId: 'log-bal', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: ORDER,
    payload: BAL, postingDate: '2026-08-09', db: db as never,
  })
  assert.equal(v.proceed, false)
})
