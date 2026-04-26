import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAccountingDocumentEvent,
  buildAccountingDocumentPayload,
  isAccountingDocumentEventType,
} from '@/lib/domain/accounting/accounting-document-event-builder'

test('sales invoice sync payload maps to a document-shaped accounting event', () => {
  const payload = buildAccountingDocumentPayload({
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'order-1',
    fallbackCurrency: 'GBP',
    payload: {
      invoiceNumber: 'INV-1001',
      contactName: 'Ada Lovelace',
      contactEmail: 'ada@example.com',
      date: '2026-04-26',
      dueDate: '2026-05-26',
      currency: 'EUR',
      currencyRateToBase: 1.18,
      reference: 'SO-1001',
      lines: [{
        itemCode: 'SKU-1',
        itemName: 'Widget',
        description: 'Widget',
        quantity: 2,
        unitAmount: 14.1234,
        accountCode: '400',
        taxType: 'OUTPUT2',
        discountAmount: 1.25,
      }],
      shippingAmount: 4.5,
      shippingDescription: 'Shipping',
      shippingAccountCode: '401',
      shippingTaxType: 'OUTPUT2',
      discountAmount: 2,
      discountAccountCode: '490',
      discountTaxType: 'OUTPUT2',
      lineAmountsIncludeTax: true,
    },
  })

  const event = buildAccountingDocumentEvent({
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'order-1',
    businessDate: payload.date,
    currency: payload.currency,
    idempotencyKey: 'accounting-sync:xero:sales_invoice:sales-order:order-1',
    payload,
    externalSystem: 'xero',
  })

  assert.equal(isAccountingDocumentEventType(event.type), true)
  assert.equal(event.currency, 'EUR')
  assert.equal(event.businessDate.toISOString(), '2026-04-26T00:00:00.000Z')
  assert.equal(event.idempotencyKey, 'accounting-sync:xero:sales_invoice:sales-order:order-1')
  assert.deepEqual(event.linesJson, {
    kind: 'accounting-document',
    schemaVersion: 1,
    documentType: 'SALES_INVOICE',
    documentNumber: 'INV-1001',
    invoiceNumber: 'INV-1001',
    contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
    date: '2026-04-26',
    dueDate: '2026-05-26',
    currency: 'EUR',
    currencyRateToBase: 1.18,
    reference: 'SO-1001',
    lineAmountMode: 'INCLUSIVE',
    lineAmountsIncludeTax: true,
    lines: [{
      itemCode: 'SKU-1',
      itemName: 'Widget',
      description: 'Widget',
      quantity: 2,
      unitAmount: 14.1234,
      accountCode: '400',
      taxType: 'OUTPUT2',
      discountAmount: 1.25,
    }],
    shipping: {
      amount: 4.5,
      description: 'Shipping',
      accountCode: '401',
      taxType: 'OUTPUT2',
    },
    discount: {
      amount: 2,
      accountCode: '490',
      taxType: 'OUTPUT2',
    },
  })
})

test('credit note document event preserves refund identity, tax, amount mode, quantity and unit amount', () => {
  const payload = buildAccountingDocumentPayload({
    type: 'CREDIT_NOTE',
    sourceEntityType: 'SalesOrderRefund',
    sourceEntityId: 'refund-1',
    fallbackCurrency: 'GBP',
    payload: {
      creditNoteNumber: 'CN-1001',
      contactName: 'Grace Hopper',
      contactEmail: 'grace@example.com',
      date: '2026-04-26',
      currency: 'GBP',
      reference: 'SO-1002',
      currencyRateToBase: 1,
      lines: [{
        description: 'Refund line',
        quantity: 3,
        unitAmount: 9.99,
        accountCode: '400',
        taxType: 'OUTPUT2',
      }],
      lineAmountsIncludeTax: false,
    },
  })

  assert.equal(payload.sourceRefundId, 'refund-1')
  assert.equal(payload.creditNoteNumber, 'CN-1001')
  assert.equal(payload.contact.name, 'Grace Hopper')
  assert.equal(payload.contact.email, 'grace@example.com')
  assert.equal(payload.currency, 'GBP')
  assert.equal(payload.lineAmountMode, 'EXCLUSIVE')
  assert.equal(payload.lines[0]?.taxType, 'OUTPUT2')
  assert.equal(payload.lines[0]?.quantity, 3)
  assert.equal(payload.lines[0]?.unitAmount, 9.99)
})

test('purchase invoice payload preserves bill fields needed by accounting connectors', () => {
  const payload = buildAccountingDocumentPayload({
    type: 'PURCHASE_INVOICE',
    sourceEntityType: 'PurchaseOrder',
    sourceEntityId: 'po-1',
    fallbackCurrency: 'GBP',
    payload: {
      invoiceNumber: 'SUP-123',
      contactName: 'Supplier Ltd',
      date: '2026-04-26',
      dueDate: '2026-05-10',
      currency: 'USD',
      currencyRateToBase: 1.25,
      reference: 'PO-123',
      supplierInvoicePath: 'uploads/supplier/SUP-123.pdf',
      lines: [{
        description: 'PO PO-123 line',
        quantity: 12,
        unitAmount: 3.4567,
        accountCode: '150',
        taxType: 'INPUT2',
      }],
    },
  })

  assert.deepEqual(payload, {
    kind: 'accounting-document',
    schemaVersion: 1,
    documentType: 'PURCHASE_INVOICE',
    documentNumber: 'SUP-123',
    invoiceNumber: 'SUP-123',
    contact: { name: 'Supplier Ltd' },
    date: '2026-04-26',
    dueDate: '2026-05-10',
    currency: 'USD',
    currencyRateToBase: 1.25,
    reference: 'PO-123',
    lineAmountMode: 'EXCLUSIVE',
    lineAmountsIncludeTax: false,
    supplierInvoicePath: 'uploads/supplier/SUP-123.pdf',
    lines: [{
      description: 'PO PO-123 line',
      quantity: 12,
      unitAmount: 3.4567,
      accountCode: '150',
      taxType: 'INPUT2',
    }],
  })
})

test('document payload validation rejects malformed commercial documents', () => {
  assert.throws(() => buildAccountingDocumentPayload({
    type: 'CREDIT_NOTE',
    sourceEntityType: 'SalesOrderRefund',
    sourceEntityId: 'refund-1',
    fallbackCurrency: 'GBP',
    payload: {
      contactName: 'Customer',
      date: '2026-04-26',
      currency: 'GBP',
      lines: [{ description: 'Refund line', quantity: 1, unitAmount: 10 }],
    },
  }), /accountCode is required/)

  assert.throws(() => buildAccountingDocumentPayload({
    type: 'SALES_INVOICE',
    sourceEntityType: 'SalesOrder',
    sourceEntityId: 'order-1',
    fallbackCurrency: 'GBP',
    payload: {
      contactName: 'Customer',
      date: '2026-04-26',
      currency: 'GBP',
      lines: [],
    },
  }), /at least one line/)
})
