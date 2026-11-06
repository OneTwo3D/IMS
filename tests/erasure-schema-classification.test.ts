import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ERASURE_CLASSIFICATION, classifiedColumns } from '../lib/domain/erasure/erasure-classification.ts'

/**
 * FAIL-CLOSED: every String or Json column on a table that hangs off a customer or an order must be
 * classified (erased / retained / not-personal) in lib/domain/erasure/erasure-classification.ts. A column
 * added later, with no verdict, fails here instead of quietly surviving every erasure.
 */

const SCHEMA = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')

function textColumns(model: string): string[] {
  const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)
  assert.ok(m, `model ${model} must exist in the schema`)
  const out: string[] = []
  for (const raw of m[1].split('\n')) {
    const line = raw.split('//')[0].trim()
    const col = /^(\w+)\s+(String|Json)(\[\])?(\?)?(\s|$)/.exec(line)
    if (col) out.push(col[1])
  }
  return out
}

test('every text or Json column on a customer- or order-linked table has an erasure verdict', () => {
  const missing: string[] = []
  for (const model of Object.keys(ERASURE_CLASSIFICATION)) {
    const classified = new Set(classifiedColumns(model))
    for (const column of textColumns(model)) {
      if (!classified.has(column)) missing.push(`${model}.${column}`)
    }
  }
  assert.deepEqual(missing, [], `classify these columns in lib/domain/erasure/erasure-classification.ts: ${missing.join(', ')}`)
})

test('no classification entry names a column that no longer exists (a stale entry would mask a rename)', () => {
  const stale: string[] = []
  for (const model of Object.keys(ERASURE_CLASSIFICATION)) {
    const present = new Set(textColumns(model))
    for (const column of classifiedColumns(model)) if (!present.has(column)) stale.push(`${model}.${column}`)
  }
  const dupes = Object.keys(ERASURE_CLASSIFICATION).flatMap((m) => classifiedColumns(m).filter((c, i, a) => a.indexOf(c) !== i).map((c) => `${m}.${c}`))
  assert.deepEqual(dupes, [], 'a column has exactly one verdict')
  assert.deepEqual(stale, [])
})

test('the classification is not vacuous: personal columns are classified erased, the decided retentions are retained', () => {
  const erased = (m: string, c: string) => assert.ok(ERASURE_CLASSIFICATION[m].erased.includes(c), `${m}.${c}`)
  for (const c of ['customerName', 'customerEmail', 'customerVatNumber', 'billingAddress', 'shippingAddress', 'notes', 'internalNotes', 'trackingNumber']) erased('SalesOrder', c)
  for (const c of ['firstName', 'lastName', 'email', 'phone', 'company', 'taxNumber', 'billingAddress', 'shippingAddress', 'notes']) erased('Customer', c)
  erased('Shipment', 'trackingNumber')
  erased('EmailOutbox', 'toEmail')
  erased('Notification', 'message')
  const retained = (m: string, c: string) => assert.ok((ERASURE_CLASSIFICATION[m].retained[c] ?? '').length > 10, `${m}.${c} must carry a retention reason`)
  retained('SalesOrder', 'invoicePdfPath')
  retained('SalesOrderRefund', 'reason')
})

test('the schema parser sees the erasure marker column, so the test would notice a rename', () => {
  assert.match(SCHEMA, /erasedAt\s+DateTime\?/)
})
