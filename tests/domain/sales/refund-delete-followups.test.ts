import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * #1132 review follow-ups for the refund delete, the parts that need no database: the proof that a void row never sent anything, the token
 * validity the bounded window relies on, the producer and section wiring, and the supplier return's refusal wording (LOW-1). The database
 * halves are in tests/concurrency/refund-delete-void-fence.concurrent.test.ts and document-delete-fence-race.concurrent.test.ts.
 */

test('#1132 MED-3 voidRowProvenNeverSent: only an unstamped row under custody (from this build), or a never-failed never-reclaimed older row', async () => {
  const { voidRowProvenNeverSent, REFUND_DELETE_VOID_STAMPS_ATTEMPTS } = await import('@/lib/domain/sales/refund-delete-service')
  const marked = { _refundDelete: { [REFUND_DELETE_VOID_STAMPS_ATTEMPTS]: true } }
  const row = (over: Record<string, unknown>) => ({ retryCount: 0, attemptRevision: 1, remoteAttemptedAt: null, createDispatchedAt: null, attemptStampingCustodyAt: new Date(), payload: marked, ...over }) as never
  assert.equal(voidRowProvenNeverSent(null), false)
  assert.equal(voidRowProvenNeverSent(row({})), true)
  assert.equal(voidRowProvenNeverSent(row({ retryCount: 3, attemptRevision: 7 })), true, 'claimed and handed back many times, never stamped: never sent')
  assert.equal(voidRowProvenNeverSent(row({ remoteAttemptedAt: new Date() })), false, 'an attempt reached the POST')
  assert.equal(voidRowProvenNeverSent(row({ createDispatchedAt: new Date() })), false)
  assert.equal(voidRowProvenNeverSent(row({ attemptStampingCustodyAt: null, retryCount: 1 })), false, 'no custody: the null stamp proves nothing')
  // An older row (queued before the stamp existed): only the pre-#1132 rule.
  assert.equal(voidRowProvenNeverSent(row({ payload: {} })), true)
  assert.equal(voidRowProvenNeverSent(row({ payload: {}, retryCount: 1 })), false)
  assert.equal(voidRowProvenNeverSent(row({ payload: {}, attemptRevision: 2 })), false)
})

test('#1132 R2-MED-1: a token resolved before the locked transaction stays valid for the whole of it (no refresh inside the bound)', async () => {
  const { XERO_TOKEN_MIN_VALIDITY_MS } = await import('@/lib/connectors/xero/auth')
  const svc = await import('@/lib/domain/sales/refund-delete-service')
  assert.ok(XERO_TOKEN_MIN_VALIDITY_MS > svc.REFUND_DELETE_VOID_TX_TIMEOUT_MS + svc.REFUND_DELETE_VOID_TX_MAX_WAIT_MS,
    `${XERO_TOKEN_MIN_VALIDITY_MS} must exceed the transaction's ${svc.REFUND_DELETE_VOID_TX_TIMEOUT_MS + svc.REFUND_DELETE_VOID_TX_MAX_WAIT_MS} ms`)
  assert.ok(svc.REFUND_DELETE_VOID_WORST_CASE_MS < svc.REFUND_DELETE_VOID_TX_TIMEOUT_MS)
  // The worker resolves the token in `prepare` (before the transaction) and hands it to both bounded calls; the deadline goes with the void.
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const arm = processor.slice(processor.indexOf("case 'CREDIT_NOTE_VOID': {"), processor.indexOf("case 'PURCHASE_CREDIT_NOTE': {"))
  assert.match(arm, /prepare: async \(\) => \{\s*boundedAuth = await getAccessToken\(\)/)
  assert.match(arm, /auth: boundedAuth/)
  assert.match(arm, /deadlineAt: bounded\.deadlineAt/)
  const service = readFileSync('lib/domain/sales/refund-delete-service.ts', 'utf8')
  const worker = service.slice(service.indexOf('export async function voidCreditNoteThenCompleteRefundDeletion('))
  assert.ok(worker.indexOf('ledger.prepare()') < worker.indexOf('const deadline = clock()'), 'prepared before the deadline is fixed')
  assert.ok(worker.indexOf('const deadline = clock()') < worker.indexOf('client.$transaction('), 'and before the transaction')
})

test('#1132 LOW-1: a supplier return refused by the pending-delete fence keeps the fence\'s own sentence', async () => {
  const { toInventoryConstraintMessage } = await import('@/lib/domain/inventory/prisma-errors')
  const { PendingDocumentDeletionError } = await import('@/lib/domain/accounting/document-delete-pending')
  const sentence = 'The bill SUP-1 is being deleted in IMS and Xero, so payments, credit notes, refunds and edits are refused until the delete finishes. Nothing was changed. Follow the delete in Sync.'
  assert.equal(toInventoryConstraintMessage(new PendingDocumentDeletionError(sentence), 'Failed to return purchase order stock.'), sentence)
})

test('#1132 R2-LOW-6: the refund delete\'s tasks are listed in their own section, never as warehouse queries, and Done touches no connector', async () => {
  const { REFUND_DELETE_TASK_REASONS, isRefundDeleteTaskReason } = await import('@/lib/domain/sales/refund-delete-task-reasons')
  const { WMS_OPERATOR_TASK_REASONS } = await import('@/lib/domain/wms/operator-tasks')
  for (const reason of REFUND_DELETE_TASK_REASONS) {
    assert.ok((WMS_OPERATOR_TASK_REASONS as readonly string[]).includes(reason), reason)
    assert.equal(isRefundDeleteTaskReason(reason), true)
  }
  assert.equal(isRefundDeleteTaskReason('PARTIAL_REMOVAL_CHECK'), false)
  const actions = readFileSync('app/actions/wms-operator-tasks.ts', 'utf8')
  const warehouse = actions.slice(actions.indexOf('export async function listWmsOperatorTasks('), actions.indexOf('export type RefundDeleteTaskRow'))
  assert.match(warehouse, /notIn: \['SHOP_REFUND_DUE' as const, \.\.\.REFUND_DELETE_TASK_REASONS\]/, 'the warehouse section excludes them')
  assert.match(actions, /export async function listRefundDeleteTasks\(/)
  assert.match(readFileSync('app/(dashboard)/sync/exceptions/page.tsx', 'utf8'), /<RefundDeleteTasksSection data=\{refundDeletePage\} \/>/)
  // Done for these reasons is the plain arm: the only connector read is the partial-removal check's.
  const done = readFileSync('lib/domain/wms/operator-task-done.ts', 'utf8')
  assert.match(done, /const partial = task\.reason === 'PARTIAL_REMOVAL_CHECK'/)
  assert.equal((done.match(/readLines\)\(/g) ?? []).length, 1, 'one connector read, behind the partial-removal check')
  assert.match(done, /IMS changed nothing in Xero, the warehouse or the refund/)
})

test('#1132 MED-4: the sales invoice UPDATE producer, the payment registration, the Woo paid flag and the credit-note allocation read the fence under the order lock', () => {
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  const inTx = sales.slice(sales.indexOf('if (options?.updateInTx) {'), sales.indexOf('if (options?.enqueueInTx) {'))
  assert.ok(inTx.indexOf('await assertNoPendingDeletion(so.id, tx)') > -1 && inTx.indexOf('await assertNoPendingDeletion(so.id, tx)') < inTx.indexOf('queueSalesInvoiceUpdateForExistingAccountingInvoice('), 'before the update is queued')
  const enqueue = readFileSync('lib/domain/accounting/invoice-payment-enqueue.ts', 'utf8')
  const run = enqueue.slice(enqueue.indexOf('const runEnqueue = () => db.$transaction(async (tx) => {'))
  assert.ok(run.indexOf('await lockSalesOrder(tx, params.orderId)') < run.indexOf('pendingDeletionError(params.orderId, tx)'))
  assert.ok(run.indexOf('pendingDeletionError(params.orderId, tx)') < run.indexOf('queueAccountingSyncTxWithOutcome(tx, {'))
  const woo = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  const paid = woo.slice(woo.indexOf('async function recordWcPaidTransition('))
  assert.ok(paid.indexOf('await lockSalesOrder(tx, orderId)') < paid.indexOf('pendingDeletionError(orderId, tx)'))
  assert.ok(paid.indexOf('pendingDeletionError(orderId, tx)') < paid.indexOf("data: { paidAt, unregisteredPaidAt: paidAt }"))
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const allocation = processor.slice(processor.indexOf('const reading = await db.$transaction(async (tx) => {\n    await lockSalesOrder(tx, refundRow.orderId)'))
  assert.ok(allocation.indexOf('pendingDeletionError(refundRow.orderId, tx)') > -1 && allocation.indexOf('pendingDeletionError(refundRow.orderId, tx)') < allocation.indexOf('readCreditNoteSettlementFacts(tx'))
  const po = readFileSync('app/actions/purchase-orders.ts', 'utf8')
  const post = po.slice(po.indexOf('const postSupplierCreditNoteTransaction = () => db.$transaction(async (tx) => {'))
  assert.ok(post.indexOf('FROM purchase_orders WHERE id = ${cn.poId} FOR UPDATE') < post.indexOf('await assertNoPendingDeletion(cn.purchaseInvoiceId, tx)'))
  assert.ok(post.indexOf('await assertNoPendingDeletion(cn.purchaseInvoiceId, tx)') < post.indexOf("data: { status: 'POSTED', postedAt: creditNotePostedAt }"))
})
