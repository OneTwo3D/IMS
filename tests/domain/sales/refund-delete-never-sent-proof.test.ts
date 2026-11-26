import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * o3d-2gv2g: the #1136 review follow-ups for the refund delete, the parts that need no database. The database halves (the rollback/custody
 * case, the unread, the not-sent read, the give-up task race) are in tests/concurrency/refund-delete-void-fence.concurrent.test.ts.
 */

test('o3d-2gv2g MED-1 creditNoteStandsInLedger: only a status Xero returned, and not VOIDED / DELETED, lets a row close as never sent', async () => {
  const { creditNoteStandsInLedger } = await import('@/lib/domain/sales/refund-delete-service')
  assert.equal(creditNoteStandsInLedger('AUTHORISED'), true)
  assert.equal(creditNoteStandsInLedger('PAID'), true)
  assert.equal(creditNoteStandsInLedger('VOIDED'), false)
  assert.equal(creditNoteStandsInLedger('DELETED'), false)
  assert.equal(creditNoteStandsInLedger(null), false, 'unread is not standing')
  assert.equal(creditNoteStandsInLedger(undefined), false)
  assert.equal(creditNoteStandsInLedger(''), false)
})

test('o3d-2gv2g MED-1 retireRefusedRefundDeleteVoid refuses without Xero\'s word, before it touches the database', async () => {
  const { retireRefusedRefundDeleteVoid } = await import('@/lib/domain/sales/refund-delete-service')
  let touched = 0
  const client = new Proxy({}, { get: () => { touched++; return () => { throw new Error('must not be reached') } } }) as never
  for (const ledgerStatus of [null, undefined, 'VOIDED', 'DELETED']) {
    assert.equal(await retireRefusedRefundDeleteVoid(client, { voidSyncLogId: 'v', attemptRevision: 1, claimedAt: new Date(), refundId: 'r', why: 'x', ledgerStatus }), false)
  }
  assert.equal(touched, 0)
})

test('o3d-2gv2g MED-1: the refusal always reads Xero before it can report a row proven never sent (no early return on the row\'s facts)', () => {
  const src = readFileSync('lib/domain/sales/refund-delete-service.ts', 'utf8')
  const fn = src.slice(src.indexOf('async function reportVoidFailure('))
  const read = fn.indexOf('ledger.readCreditNoteStatus(bounded)')
  assert.ok(read > -1)
  // The only place provenNeverSent can be true is after the read, and only with the status it returned.
  assert.ok(fn.indexOf('provenNeverSent: rowSaysNeverSent, ledgerStatus: status') > read)
  assert.equal(fn.slice(0, read).includes('provenNeverSent: true'), false)
  // LOW-1: the not-sent kinds return before the read.
  assert.ok(fn.indexOf('if (!refused) return') > -1 && fn.indexOf('if (!refused) return') < read)
})

test('o3d-2gv2g LOW-3 refundDeleteWaitsSinceLastFailure: the run of waits at the row\'s current retry count, newest first', async () => {
  const { refundDeleteWaitsSinceLastFailure, REFUND_DELETE_MAX_DEFERRALS } = await import('@/lib/connectors/xero/sync-processor')
  const client = (counts: Array<unknown>) => ({ activityLog: { findMany: async (args: { take: number }) => counts.slice(0, args.take).map((waitRetryCount) => ({ metadata: waitRetryCount === undefined ? {} : { waitRetryCount } })) } }) as never
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 0, client([0, 0, 0])), 3)
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 1, client([1, 1, 0, 0, 0])), 2, 'the waits before the last failure do not count')
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 0, client([0, 4, 4, 3])), 1, 'an operator retry put the count back to 0: the earlier life does not count')
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 2, client([0, 0])), 0)
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 0, client([undefined, 0])), 0, 'a wait recorded before this build ends the run')
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 0, client(Array(500).fill(0))), REFUND_DELETE_MAX_DEFERRALS + 1, 'bounded read')
  const broken = { activityLog: { findMany: async () => { throw new Error('down') } } } as never
  assert.equal(await refundDeleteWaitsSinceLastFailure('e', 0, broken), REFUND_DELETE_MAX_DEFERRALS, 'unreadable: the cap, no wait taken')
})

test('o3d-2gv2g LOW-2: the give-up task is raised inside the fenced failure write, after the CAS and only when it made the row FAILED; refundDeleteVoidFailure no longer raises it', () => {
  const src = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const apply = src.slice(src.indexOf('export async function applyMainSyncFailureRetry('), src.indexOf('async function logFollowUpRetry('))
  const lock = apply.indexOf('refundDelete.lockOrderOfRefundDeleteVoid(tx, entry.referenceId)')
  const cas = apply.indexOf('const updated = await tx.accountingSyncLog.updateMany({')
  const won = apply.indexOf('if (updated.count > 0) {')
  const raise = apply.indexOf('refundDelete.raiseRefundDeleteVoidStuckTask(tx, {')
  assert.ok(lock > -1 && lock < cas, 'the order is locked before the sync row (canonical order)')
  assert.ok(won > cas && raise > won && raise < apply.indexOf('return { finalFailure: computedFinal }'))
  assert.ok(apply.indexOf('giveUp: attempt.attemptRevision') > raise)
  const mapping = src.slice(src.indexOf('export async function refundDeleteVoidFailure('), src.indexOf('async function processEntry('))
  assert.equal(mapping.includes('raiseRefundDeleteVoidStuckTask'), false)
  const service = readFileSync('lib/domain/sales/refund-delete-service.ts', 'utf8')
  assert.match(service, /dedupeBasis: `refund-delete-void-stuck:\$\{input\.voidSyncLogId\}:give-up-\$\{input\.giveUp\}`/)
})

test('o3d-2gv2g LOW-5: the allocation wait behind a document delete records its evidence on the first wait only, and is capped', async () => {
  const { AWAITING_DOCUMENT_DELETE_MAX_MS, AWAITING_DOCUMENT_DELETE_RETRY_DELAY_MS } = await import('@/lib/connectors/xero/sync-processor')
  assert.ok(AWAITING_DOCUMENT_DELETE_MAX_MS > AWAITING_DOCUMENT_DELETE_RETRY_DELAY_MS)
  const src = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const branch = src.slice(src.indexOf('if (reading.deletePending) {'), src.indexOf('const facts = reading.facts'))
  assert.match(branch, /action: 'xero_sync_awaiting_document_delete_before_post'/)
  assert.match(branch, /> AWAITING_DOCUMENT_DELETE_MAX_MS/)
  assert.match(branch, /recordEvidence: firstWait === null/)
})

test('o3d-2gv2g LOW-6: a receipt held behind a document delete has its own action; inline callers read it as on record, the sweep does not', () => {
  const enqueue = readFileSync('lib/domain/accounting/invoice-payment-enqueue.ts', 'utf8')
  const held = enqueue.slice(enqueue.indexOf("if (typeof outcome === 'object' && 'deletePending' in outcome) {"))
  assert.ok(held.indexOf('warn(INVOICE_PAYMENT_HELD_DOCUMENT_DELETE_ACTION,') > -1)
  assert.equal(held.slice(0, held.indexOf('return registeredFor.connector')).includes("'invoice_payment_not_registered'"), false)
  const sweep = readFileSync('lib/domain/accounting/receipt-registration-sweep.ts', 'utf8')
  assert.match(sweep, /obligationIsOnRecord\(r\.orderId, r\.id, \{ heldCountsAsRecorded: false \}\)/)
  // The sweep's candidate query still excludes only the decided refusal.
  const query = sweep.slice(sweep.indexOf('async function selectUnresolvedReceiptIds('))
  assert.equal(query.slice(0, query.indexOf('LIMIT ${take}')).includes('invoice_payment_held_document_delete'), false)
})
