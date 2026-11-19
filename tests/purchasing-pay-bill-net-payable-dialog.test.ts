import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-hqvrp.399 (review): the Mark-Bill-Paid dialog must show the figure markBillPaid registers (the NET payable), with the gross as secondary text.
 * A source-level check (the dialog is a client component): the type carries the field and the dialog renders it, not `totalForeign`, as the amount.
 */
const actions = readFileSync('app/actions/purchase-orders.ts', 'utf8')
const client = readFileSync('app/(dashboard)/purchase-orders/[id]/po-detail-client.tsx', 'utf8')

test('InvoiceRow carries netPayableForeign and the getPurchaseOrder mapping fills it', () => {
  assert.match(actions.slice(actions.indexOf('export type InvoiceRow')), /netPayableForeign: number/)
  assert.match(actions, /netPayableForeign: billNetPayableForeign\(inv, po\.currency\)\.toNumber\(\)/)
})

test('the pay dialog shows the net payable as the amount and the gross only as secondary text', () => {
  const dialog = client.slice(client.indexOf('function PayBillDialog'))
  const amountRow = dialog.slice(dialog.indexOf('Amount to pay'), dialog.indexOf('Bank Account'))
  assert.match(amountRow, /money\(invoice\.netPayableForeign\)/)
  assert.match(amountRow, /pay-bill-gross/)
  assert.doesNotMatch(dialog.slice(dialog.indexOf('<DialogTitle>Mark Bill as Paid'), dialog.indexOf('Amount to pay')), /money\(invoice\.totalForeign\)/)
})

test('the bill row lists the net payable with the gross as secondary text', () => {
  assert.match(client, /\{money\(inv\.netPayableForeign\)\}/)
  assert.match(client, /\(gross \{money\(inv\.totalForeign\)\}\)/)
})
