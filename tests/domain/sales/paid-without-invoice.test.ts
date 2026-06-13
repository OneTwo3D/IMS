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

// audit-s3en: cancel-time gap. Trigger-independent — once cancelled, no
// auto-generation can fire, so any fully-paid uninvoiced order must be surfaced.
test('cancel warn: fires for a fully-paid order with no invoice (the on_shipped gap)', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ isPaid: true, hasInvoiceNumber: false }), true)
})

test('cancel warn: does NOT fire when the cancelled order was never fully paid', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ isPaid: false, hasInvoiceNumber: false }), false)
})

test('cancel warn: does NOT fire when the paid order already has an invoice (e.g. on_paid)', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ isPaid: true, hasInvoiceNumber: true }), false)
})

test('cancel warn: does NOT fire for an unpaid order with an invoice', () => {
  assert.equal(shouldWarnPaidOrderCancelledWithoutInvoice({ isPaid: false, hasInvoiceNumber: true }), false)
})
