import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveSalesOrderDeleteBlock } from '@/lib/domain/sales/order-delete-affordance'

/**
 * o3d-0zy: `deleteSalesOrder` refuses whenever a live accounting sync log references the order, and
 * `queueSalesInvoiceForOrder` runs for every non-draft order — so with accounting sync enabled the
 * Delete button on a PENDING_PAYMENT order always answered with a refusal. The docs half shipped
 * with PR #580; this pins the UI half.
 */

test('a DRAFT stays freely deletable — a draft never queues an accounting invoice', () => {
  assert.equal(
    resolveSalesOrderDeleteBlock({ status: 'DRAFT', accountingInvoiceId: null, accountingSyncEnabled: true }),
    null,
  )
})

test('a non-draft order with accounting sync ON is blocked, and pointed at Cancel', () => {
  const block = resolveSalesOrderDeleteBlock({
    status: 'PENDING_PAYMENT',
    accountingInvoiceId: null,
    accountingSyncEnabled: true,
  })
  assert.equal(block?.remedy, 'cancel')
  assert.match(block!.reason, /queued for this order/)
  assert.match(block!.reason, /Cancel the order instead/)
})

test('a POSTED invoice sends the operator to finance, NOT to Cancel', () => {
  // Cancelling does not reverse a posted invoice — it would leave a live receivable and recognised
  // revenue against a cancelled order, which is exactly the wrong remedy to advertise.
  const block = resolveSalesOrderDeleteBlock({
    status: 'ALLOCATED',
    accountingInvoiceId: 'INV-123',
    accountingSyncEnabled: true,
  })
  assert.equal(block?.remedy, 'finance')
  assert.match(block!.reason, /credit note or reversal/)
})

test('a posted invoice still blocks even with accounting sync switched off', () => {
  // The invoice id outlives the connector toggle and outlives sync-log retention.
  const block = resolveSalesOrderDeleteBlock({
    status: 'PENDING_PAYMENT',
    accountingInvoiceId: 'INV-123',
    accountingSyncEnabled: false,
  })
  assert.equal(block?.remedy, 'finance')
})

test('with accounting sync OFF and nothing posted, a non-draft order is still deletable', () => {
  // Nothing was ever queued, so the server would not refuse — the button must not be blocked on
  // status alone.
  assert.equal(
    resolveSalesOrderDeleteBlock({ status: 'PENDING_PAYMENT', accountingInvoiceId: null, accountingSyncEnabled: false }),
    null,
  )
})

test('the sales-order page disables Delete with the reason instead of surfacing a refusal', async () => {
  const client = await readFile('app/(dashboard)/sales/[id]/so-detail-client.tsx', 'utf8')

  assert.match(
    client,
    /const deleteBlock = resolveSalesOrderDeleteBlock\(\{[\s\S]{0,300}?accountingSyncEnabled,/,
    'the page must resolve the block from the accounting data it already holds',
  )
  assert.match(
    client,
    /disabled=\{isPending \|\| deleteBlock !== null\}/,
    'the Delete button must be disabled when a refusal is predictable',
  )
  assert.match(
    client,
    /<span title=\{deleteBlock\?\.reason\}/,
    'and carry the reason on a wrapper, since a disabled button shows no tooltip of its own',
  )
})
