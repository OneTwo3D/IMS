import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldWarnPaidWithoutInvoice, shouldWarnPaidOrderCancelledWithoutInvoice } from '@/lib/domain/sales/paid-without-invoice'

test('warns when fully paid, no invoice, manual trigger', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: 'manual' }), true)
})

test('warns when trigger is unset/null (never auto-generates)', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: null }), true)
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: undefined }), true)
})

test('does NOT warn for on_paid (the caller generates the invoice instead)', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: 'on_paid' }), false)
})

test('does NOT warn for on_shipped (invoice generates at dispatch)', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: 'on_shipped' }), false)
})

test('does NOT warn when an invoice already exists', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: true, invoiceTrigger: 'manual' }), false)
})

test('does NOT warn when the order did not just become paid', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: false, hasInvoiceNumber: false, invoiceTrigger: 'manual' }), false)
})

test('warns for an unknown/future trigger value (safe default)', () => {
  assert.equal(shouldWarnPaidWithoutInvoice({ becamePaid: true, hasInvoiceNumber: false, invoiceTrigger: 'some_future_trigger' }), true)
})

// audit-s3en/45kd: cancel-time gap. Trigger-independent — once cancelled, no
// auto-generation can fire, so any uninvoiced order carrying settled customer
// money (fully OR partially paid) must be surfaced.
test('cancel warn: fires for a fully-paid order with no invoice (s3en, the on_shipped gap)', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment: true, hasInvoiceNumber: false }), true)
})

test('cancel warn: fires for a PARTIALLY-paid order with no invoice (45kd)', () => {
  // hasSettledPayment is true for a partial prepayment even when paidAt is null.
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment: true, hasInvoiceNumber: false }), true)
})

test('cancel warn: does NOT fire when the cancelled order carried no settled money', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment: false, hasInvoiceNumber: false }), false)
})

test('cancel warn: does NOT fire when the paid order already has an invoice (e.g. on_paid)', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment: true, hasInvoiceNumber: true }), false)
})

test('cancel warn: does NOT fire for an unpaid order with an invoice', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ hasSettledPayment: false, hasInvoiceNumber: true }), false)
})
