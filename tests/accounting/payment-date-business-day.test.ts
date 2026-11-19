import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { businessDateOfStamp } from '@/lib/business-date'

// The receipt registered with a WC invoice is dated on the London business day, like the invoice (so one order's legs never split across a day).
test('a WC payment stamp at 23:30 UTC in BST is the next London day; a winter stamp is unchanged; a bare day or junk is null', () => {
  assert.equal(businessDateOfStamp('2026-06-30T23:30:00'), '2026-07-01')
  assert.equal(businessDateOfStamp('2026-06-30T23:30:00Z'), '2026-07-01')
  assert.equal(businessDateOfStamp('2026-06-30T12:00:00'), '2026-06-30')
  assert.equal(businessDateOfStamp('2026-12-31T23:30:00'), '2026-12-31')
  assert.equal(businessDateOfStamp('2026-06-30'), null)
  assert.equal(businessDateOfStamp('2026-99-99T99:99:99'), null)
})
test('the follow-up enqueue reads the payment day through it, and the manual payment and its realised-FX journal share one helper', async () => {
  const outcome = await readFile('lib/domain/accounting/followup-enqueue-outcome.ts', 'utf8')
  assert.match(outcome, /businessDateOfStamp\(value\)/)
  const enqueue = await readFile('lib/domain/accounting/invoice-payment-enqueue.ts', 'utf8')
  assert.match(enqueue, /paymentDate: businessDateYmd\(params\.paidAt\)/)
  const sales = await readFile('app/actions/sales.ts', 'utf8')
  assert.match(sales, /date: businessDateYmd\(txResult\.paidAt\)/)
})

// o3d-oe1b0: every INVOICE_PAYMENT payload records the day convention of its own paymentDate, so R16 does not have to infer it from a row's creation instant (a revived FAILED row keeps an old one).
test('both INVOICE_PAYMENT payload builders record the London day convention', async () => {
  const marker = /\[POSTED_DAY_CONVENTION_FIELD\]: LONDON_POSTED_DAY_CONVENTION/
  assert.match(await readFile('lib/domain/accounting/invoice-payment-enqueue.ts', 'utf8'), marker)
  assert.match(await readFile('lib/connectors/xero/sync-processor.ts', 'utf8'), marker)
})
