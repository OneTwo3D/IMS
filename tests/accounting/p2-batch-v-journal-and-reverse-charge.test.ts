import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The transport is doubled: nothing here reaches Xero.
const sent: Array<Record<string, unknown>> = []
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroHttpAttemptCount: () => 0,
    xeroPost: async (_path: string, body: Record<string, unknown>) => {
      sent.push(JSON.parse(JSON.stringify(body)))
      return { ok: true, data: { ManualJournals: [{ ManualJournalID: 'MJ-1' }] } }
    },
  },
})

const loadJournals = () => import('@/lib/connectors/xero/journals')
import { journalSentPennyImbalance } from '@/lib/domain/accounting/journal-balance'
import { reverseChargeSwapMissing, SalesInvoiceReverseChargeSwapNotSetError, SalesInvoiceDoesNotReconcileError } from '@/lib/domain/sales/sales-invoice-reconciliation'

// o3d-hqvrp.59 — manual journal TaxType and penny balance. Pure: nothing here touches a network or a database.

test('a journal line with no tax type is sent on the explicit no-VAT code, not left to the account default', async () => {
  const { pushManualJournal } = await loadJournals()
  sent.length = 0
  const result = await pushManualJournal({
    date: '2026-11-01', reference: 'r', narration: 'n',
    lines: [
      { accountCode: '630', description: 'a', debit: 10 },
      { accountCode: '200', description: 'b', credit: 10 },
    ],
  })
  assert.equal(result.success, true)
  const lines = sent[0]!.JournalLines as Array<Record<string, unknown>>
  assert.deepEqual(lines.map((l) => l.TaxType), ['NONE', 'NONE'])
})

test('a line that names a tax type keeps it (the type is only defaulted when absent)', async () => {
  const { pushManualJournal } = await loadJournals()
  sent.length = 0
  const result = await pushManualJournal({
    date: '2026-11-01', reference: 'r', narration: 'n',
    lines: [
      { accountCode: '630', description: 'a', debit: 10, taxType: 'INPUT2' },
      { accountCode: '200', description: 'b', credit: 10 },
    ],
  })
  assert.equal(result.success, true)
  const lines = sent[0]!.JournalLines as Array<Record<string, unknown>>
  assert.deepEqual(lines.map((l) => l.TaxType), ['INPUT2', 'NONE'])
})

test('a journal balanced on raw sums but a penny out after per-line rounding is refused', async () => {
  const { prepareManualJournal } = await loadJournals()
  const result = prepareManualJournal({
    date: '2026-11-01', reference: 'r', narration: 'n',
    lines: [
      { accountCode: '1', description: 'a', debit: 33.333 },
      { accountCode: '2', description: 'b', debit: 33.333 },
      { accountCode: '3', description: 'c', debit: 33.334 },
      { accountCode: '4', description: 'd', credit: 100 },
    ],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /rounding/)
})

test('journalSentPennyImbalance: balanced, imbalanced and non-journal payloads', () => {
  assert.equal(journalSentPennyImbalance({ lines: [{ debit: 10.1 }, { credit: 10.1 }] }), 0)
  assert.equal(journalSentPennyImbalance({ lines: [{ debit: 33.333 }, { debit: 33.333 }, { debit: 33.334 }, { credit: 100 }] }), -1)
  assert.equal(journalSentPennyImbalance({ lines: [{ unitAmount: 5, quantity: 1 }] }), null)
  assert.equal(journalSentPennyImbalance({}), null)
})

// o3d-hqvrp.53 — a reverse-charge line with the swap setting empty is refused.

test('reverseChargeSwapMissing: only a reverse-charge line with an empty setting', () => {
  const rc = [{ taxRate: { reverseCharge: true } }]
  assert.equal(reverseChargeSwapMissing(rc, ''), true)
  assert.equal(reverseChargeSwapMissing(rc, '  '), true)
  assert.equal(reverseChargeSwapMissing(rc, null), true)
  assert.equal(reverseChargeSwapMissing(rc, 'ECOUTPUTSERVICES'), false)
  assert.equal(reverseChargeSwapMissing([{ taxRate: { reverseCharge: false } }, { taxRate: null }], ''), false)
})

test('the refusal is a reconciliation refusal, so every caller that refuses a mismatch refuses it', () => {
  const err = new SalesInvoiceReverseChargeSwapNotSetError('GBP')
  assert.ok(err instanceof SalesInvoiceDoesNotReconcileError)
  assert.match(err.message, /reverse-charge sales tax type/)
})
