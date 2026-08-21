import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideChargebackDiscountLine,
  readPostedDocumentDiscount,
  readPostedSalesInvoiceDiscountForOrder,
} from '@/lib/domain/accounting/posted-document-discount'

// ---------------------------------------------------------------------------
// o3d-356o — a chargeback must reverse the invoice that POSTED, not the one today's settings
// would produce.
//
// The Xero adapter appends its negative "Order discount" line only when the ENQUEUED payload
// carried a positive discountAmount AND a discountAccountCode. `raiseChargebackForReversedOrder`
// used `getAccountingSettings().discountAccount`, read live, as a proxy for that. When the
// discount account was configured AFTER the invoice posted, the invoice had charged the FULL
// goods value while the credit note reversed goods MINUS the discount — under-crediting by
// exactly the discount, silently, on every order.
// ---------------------------------------------------------------------------

const POSTED_WITH_DISCOUNT_LINE = {
  kind: 'accounting-document',
  documentType: 'SALES_INVOICE',
  discount: { amount: 12.5, accountCode: '4009', taxType: 'OUTPUT2' },
}
const POSTED_WITHOUT_DISCOUNT_LINE = {
  kind: 'accounting-document',
  documentType: 'SALES_INVOICE',
}

// --- reading the document -------------------------------------------------

test('a posted payload with amount + account code IS a discount line', () => {
  const posted = readPostedDocumentDiscount(POSTED_WITH_DISCOUNT_LINE)
  assert.deepEqual(posted, { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 })
})

test('a posted payload with no discount at all carried no discount line', () => {
  assert.deepEqual(readPostedDocumentDiscount(POSTED_WITHOUT_DISCOUNT_LINE), { known: true, postedDiscountLine: false })
})

test('a discount amount with NO account code carried no line — the connector requires both', () => {
  const posted = readPostedDocumentDiscount({
    kind: 'accounting-document',
    discount: { amount: 12.5 },
  })
  assert.deepEqual(posted, { known: true, postedDiscountLine: false })
})

test('a zero or negative discount amount carried no line', () => {
  assert.deepEqual(
    readPostedDocumentDiscount({ kind: 'accounting-document', discount: { amount: 0, accountCode: '4009' } }),
    { known: true, postedDiscountLine: false },
  )
  assert.deepEqual(
    readPostedDocumentDiscount({ kind: 'accounting-document', discount: { amount: -5, accountCode: '4009' } }),
    { known: true, postedDiscountLine: false },
  )
})

test('an unrecognisable payload is UNREADABLE, not "no discount line"', () => {
  const posted = readPostedDocumentDiscount({ some: 'journal' })
  assert.equal(posted.known, false)
  assert.equal(posted.known === false && posted.unreadable, true)
  assert.equal(
    posted.known === false && posted.unreadable === true && posted.reason,
    'the mirrored accounting event is not a document payload',
  )
})

// --- the decision ---------------------------------------------------------

test('discount account configured AFTER the post: the credit note credits the FULL goods value', () => {
  // The bug: live setting says "4009 is configured", so the chargeback mirrored a discount line
  // and under-credited by 12.50 against an invoice that never had one.
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 12.5,
    configuredDiscountAccount: '4009',
    posted: { known: true, postedDiscountLine: false },
  })
  assert.equal(decision.action, 'no-discount-line')
  assert.equal(
    decision.action === 'no-discount-line' && decision.reason,
    'the posted sales invoice carried no order discount line, so the chargeback credits the full goods value',
  )
})

test('the invoice DID post a discount line to the account still configured: mirror it', () => {
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 12.5,
    configuredDiscountAccount: '4009',
    posted: { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 },
  })
  assert.deepEqual(decision, { action: 'mirror-discount' })
})

test('discount account REMOVED after the post: manual, naming the account the invoice used', () => {
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 12.5,
    configuredDiscountAccount: null,
    posted: { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 },
  })
  assert.equal(
    decision.action === 'manual' && decision.reason,
    'the posted sales invoice carried an order discount line to account 4009 but no discount account is configured now',
  )
})

test('discount account CHANGED after the post: manual — the reversal must not land elsewhere', () => {
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 12.5,
    configuredDiscountAccount: '4010',
    posted: { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 },
  })
  assert.equal(
    decision.action === 'manual' && decision.reason,
    'the posted sales invoice put its order discount line on account 4009 but the configured discount account is now 4010',
  )
})

test('an unreadable posted document fails CLOSED to manual, not back to the live-setting proxy', () => {
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 12.5,
    configuredDiscountAccount: '4009',
    posted: { known: false, unreadable: true, reason: 'the accounting event could not be read (boom)' },
  })
  assert.equal(
    decision.action === 'manual' && decision.reason,
    'could not determine what the posted sales invoice did with the order discount — the accounting event could not be read (boom)',
  )
})

test('no mirrored posted document: unchanged pre-o3d-356o behaviour (live setting is the proxy)', () => {
  assert.deepEqual(
    decideChargebackDiscountLine({
      orderDiscountAmount: 12.5,
      configuredDiscountAccount: '4009',
      posted: { known: false },
    }),
    { action: 'mirror-discount' },
  )
  assert.equal(
    decideChargebackDiscountLine({
      orderDiscountAmount: 12.5,
      configuredDiscountAccount: '',
      posted: { known: false },
    }).action,
    'manual',
  )
})

test('an order with no order-level discount never gets a discount line', () => {
  const decision = decideChargebackDiscountLine({
    orderDiscountAmount: 0,
    configuredDiscountAccount: '4009',
    posted: { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 },
  })
  assert.equal(
    decision.action === 'no-discount-line' && decision.reason,
    'the order carries no order-level discount',
  )
})

// --- the loader -----------------------------------------------------------

test('reads the LATEST posted sales-invoice event — an UPDATE supersedes the create it amends', async () => {
  const seen: unknown[] = []
  const reader = {
    async findFirst(args: Record<string, unknown>) {
      seen.push(args)
      return { linesJson: POSTED_WITH_DISCOUNT_LINE }
    },
  }
  const posted = await readPostedSalesInvoiceDiscountForOrder(reader as never, 'order-1')
  assert.deepEqual(posted, { known: true, postedDiscountLine: true, accountCode: '4009', amount: 12.5 })
  assert.deepEqual(seen[0], {
    where: {
      sourceEntityType: 'SalesOrder',
      sourceEntityId: 'order-1',
      type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] },
      status: 'POSTED',
    },
    orderBy: { createdAt: 'desc' },
    select: { linesJson: true },
  })
})

test('no posted event at all is "unknown", which keeps the old behaviour', async () => {
  const reader = { async findFirst() { return null } }
  assert.deepEqual(await readPostedSalesInvoiceDiscountForOrder(reader as never, 'order-1'), { known: false })
})

test('a failing query is unreadable — it must not read as "no discount line"', async () => {
  const reader = { async findFirst() { throw new Error('connection lost') } }
  const posted = await readPostedSalesInvoiceDiscountForOrder(reader as never, 'order-1')
  assert.equal(posted.known, false)
  assert.equal(
    posted.known === false && posted.unreadable === true && posted.reason,
    'the accounting event could not be read (Error: connection lost)',
  )
})
