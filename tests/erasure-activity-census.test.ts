import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ERASED_ACTIVITY_DESCRIPTION, IDENTITY_BEARING_ENTITY_TYPES, redactIdentityKeys } from '../lib/domain/erasure/activity-identity.ts'

/**
 * FAIL-CLOSED CENSUS OF THE ACTIVITY WRITERS THAT CAN PUT A DATA SUBJECT'S IDENTITY INTO A ROW KEYED TO A CUSTOMER OR ORDER.
 *
 * The erasure redacts those rows by STRUCTURE (rows keyed to a CUSTOMER wholesale; identity-named metadata keys on order rows),
 * so it does not depend on the subject's current values. That is sound only while every writer that puts identity into such a
 * row is known. This scan finds every logActivity call keyed to CUSTOMER or SALES_ORDER whose next 16 lines mention an
 * identity field, and every action written against a CUSTOMER, and fails when one is not classified below.
 *
 *   customer-row   keyed to CUSTOMER: redacted wholesale (description replaced, identity keys replaced)
 *   staff-actor    mentions the STAFF member who acted (their own email), not the customer
 *   no-write       reads an identity field to decide something; none is written to the row
 */
const cwd = new URL('..', import.meta.url).pathname

const IDENTITY_MENTION: Record<string, { calls: number; verdict: string }> = {
  'app/actions/customers.ts': { calls: 3, verdict: 'customer-row (created, updated, and their failure rows)' },
  'app/actions/accounting-ledger-check.ts': { calls: 1, verdict: 'staff-actor' },
  'app/actions/sales.ts': { calls: 1, verdict: 'staff-actor (withdrawal hold released by)' },
  'lib/connectors/xero/sync-processor.ts': { calls: 1, verdict: 'no-write (follow-up plan reads the customer email)' },
}
const CUSTOMER_ACTIONS: Record<string, string[]> = {
  'app/actions/customers.ts': ["'created'", "'created'", "'updated'", "'updated'"],
  'lib/domain/erasure/erase-personal-data.ts': ['ERASURE_RECORD_ACTION', 'ERASURE_FAILURE_ACTION'],
}

function scan() {
  const files = execFileSync('git', ['grep', '-lE', 'logActivity(Persisted|InTransaction)?\\(', '--', 'app', 'lib', ':!app/generated', ':!*.test.ts'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean)
  const mention: Record<string, number> = {}
  const customerActions: Record<string, string[]> = {}
  for (const file of files) {
    const lines = readFileSync(`${cwd}${file}`, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/logActivity(Persisted|InTransaction)?\(/.test(line)) return
      const window = lines.slice(i, i + 16).join('\n')
      const entity = /entityType:\s*'(CUSTOMER|SALES_ORDER)'/.exec(window)
      if (!entity) return
      if (/customerName|customerEmail|contactName|contactEmail|firstName|lastName|billingAddress|shippingAddress|\.email\b|\.phone\b/.test(window)) mention[file] = (mention[file] ?? 0) + 1
      if (entity[1] === 'CUSTOMER') (customerActions[file] ??= []).push(/action:\s*([^,\n]+)/.exec(window)?.[1]?.trim() ?? '?')
    })
  }
  return { mention, customerActions }
}

test('every activity writer that can put identity into a customer- or order-keyed row is classified', () => {
  const { mention } = scan()
  assert.deepEqual(mention, Object.fromEntries(Object.entries(IDENTITY_MENTION).map(([f, v]) => [f, v.calls])))
})

test('every action written against a CUSTOMER is known, and CUSTOMER rows are redacted wholesale', () => {
  const { customerActions } = scan()
  assert.deepEqual(customerActions, CUSTOMER_ACTIONS)
  assert.ok(IDENTITY_BEARING_ENTITY_TYPES.includes('CUSTOMER'))
  assert.ok(ERASED_ACTIVITY_DESCRIPTION.length > 0 && !/\$\{/.test(ERASED_ACTIVITY_DESCRIPTION))
})

test('structural metadata redaction replaces identity-named keys at any depth and keeps ids, markers and amounts', () => {
  const out = redactIdentityKeys({
    connector: 'woocommerce', externalOrderId: '42', customerId: 'c1', erasedCustomerId: 'c1', orderNumber: 'SO-1', total: 12.5, shippingService: 'RM 24',
    firstName: 'Alicia', contact: { email: 'a@b.test', phone: '1', name: 'A B' }, lines: [{ sku: 'X', notes: 'ring bell' }], trackingNumber: 'T1', billingAddress: { line1: 'x' },
  }) as Record<string, unknown>
  assert.deepEqual(out, {
    connector: 'woocommerce', externalOrderId: '42', customerId: 'c1', erasedCustomerId: 'c1', orderNumber: 'SO-1', total: 12.5, shippingService: 'RM 24',
    firstName: '[erased]', contact: { email: '[erased]', phone: '[erased]', name: '[erased]' }, lines: [{ sku: 'X', notes: '[erased]' }], trackingNumber: '[erased]', billingAddress: '[erased]',
  })
})
