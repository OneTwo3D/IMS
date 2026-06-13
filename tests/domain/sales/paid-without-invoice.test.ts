import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldWarnPaidWithoutInvoice } from '@/lib/domain/sales/paid-without-invoice'

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
