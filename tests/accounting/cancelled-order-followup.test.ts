import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CANCELLED_ORDER_REFUSED_FOLLOW_UP_TYPES,
  ORDER_SCOPED_FOLLOW_UP_DISPOSITION,
  cancelledOrderFollowUpReason,
  planInvoiceCustomerFollowUps,
} from '../../lib/domain/accounting/cancelled-order-followup.ts'

/**
 * What an invoice's order-scoped follow-ups do when the order is cancelled. The behavioural arms (the drain under the order row lock, a real cancellation) are in
 * tests/concurrency/cancelled-order-followup.concurrent.test.ts; this file pins the census and the enqueue plan.
 */

// [mutation: add or drop a type in the census; flip a disposition]
test('CENSUS: the order-scoped follow-ups of a posted invoice, and what each does for a cancelled order', () => {
  assert.deepEqual(ORDER_SCOPED_FOLLOW_UP_DISPOSITION, {
    INVOICE_PAYMENT: 'timing',
    INVOICE_PDF: 'allow',
    INVOICE_EMAIL: 'refuse',
    WC_INVOICE_NOTE: 'refuse',
  })
  assert.deepEqual([...CANCELLED_ORDER_REFUSED_FOLLOW_UP_TYPES].sort(), ['INVOICE_EMAIL', 'WC_INVOICE_NOTE'])
  console.log(`order-scoped follow-up types: ${Object.keys(ORDER_SCOPED_FOLLOW_UP_DISPOSITION).length}; refused for a cancelled order: ${CANCELLED_ORDER_REFUSED_FOLLOW_UP_TYPES.length}`)
})

test('CENSUS: every order-scoped follow-up type the processor knows is classified (the supplier-scoped ones are not order follow-ups)', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const enumBody = /enum AccountingSyncType \{([\s\S]*?)\n\}/.exec(schema)![1]!
  const members = enumBody.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l))
  const followUpTypeLine = /type FollowUpSyncType = ([^\n]+)/.exec(readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8'))![1]!
  const followUps = [...followUpTypeLine.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
  for (const t of followUps) assert.ok(members.includes(t), `${t} is a sync type`)
  const supplierScoped = ['BILL_ATTACHMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']
  const orderScoped = followUps.filter((t) => !supplierScoped.includes(t)).sort()
  assert.deepEqual(orderScoped, Object.keys(ORDER_SCOPED_FOLLOW_UP_DISPOSITION).sort(), 'a new order-scoped follow-up type must be classified here')
})

test('every refused type is guarded at the drain, in its own processor case, and the enqueue uses the plan', () => {
  const src = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  for (const t of CANCELLED_ORDER_REFUSED_FOLLOW_UP_TYPES) {
    const start = src.indexOf(`case '${t}': {`)
    assert.ok(start > 0, `${t} has a processor case`)
    const end = src.indexOf('\n    case ', start + 10)
    assert.match(src.slice(start, end), new RegExp(`refuseFollowUpForCancelledOrder\\(\\{[^}]*type: '${t}'`), `${t} is guarded under the order lock before it sends`)
  }
  assert.match(src, /planInvoiceCustomerFollowUps\(/)
  assert.match(src, /if \(plan\.email\)/)
  assert.match(src, /if \(plan\.note\)/)
})

// [mutation: ignore the status / queue the email or the note for a cancelled order / suppress an active order]
test('ENQUEUE PLAN: a cancelled order queues neither the email nor the note and says why; an active order queues what it always did', () => {
  const cancelled = planInvoiceCustomerFollowUps({ status: 'CANCELLED', customerEmail: 'a@b.c', hasWooCommerceLink: true })
  assert.deepEqual(cancelled, { email: false, note: false, suppressedForCancellation: true })
  assert.deepEqual(planInvoiceCustomerFollowUps({ status: 'PROCESSING', customerEmail: 'a@b.c', hasWooCommerceLink: true }), { email: true, note: true, suppressedForCancellation: false })
  assert.deepEqual(planInvoiceCustomerFollowUps({ status: 'PROCESSING', customerEmail: null, hasWooCommerceLink: true }), { email: false, note: true, suppressedForCancellation: false })
  assert.deepEqual(planInvoiceCustomerFollowUps({ status: 'DISPATCHED', customerEmail: 'a@b.c', hasWooCommerceLink: false }), { email: true, note: false, suppressedForCancellation: false })
})

test('the refusal reason is specific to what was not done and says nothing was sent', () => {
  assert.match(cancelledOrderFollowUpReason('INVOICE_EMAIL'), /emailing the invoice to the customer/)
  assert.match(cancelledOrderFollowUpReason('WC_INVOICE_NOTE'), /invoice note on the WooCommerce order/)
  assert.match(cancelledOrderFollowUpReason('WC_INVOICE_NOTE'), /Nothing was sent/)
})
