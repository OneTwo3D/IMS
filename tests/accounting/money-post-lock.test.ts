import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0m56 round 4, Codex CRITICAL #2 — the lock the money post is actually made under.
 *
 * The fence's own tests drive an injected double, which proves the FENCE serializes. These prove
 * the thing that double stands for: that the real lock is the shared connection-pinned
 * `pg_try_advisory_lock`, taken in the money-post namespace ON THE EXTERNAL DOCUMENT, that it
 * refuses rather than waits, and that it is released however the run leaves. A leaked lock here
 * would make one document unpayable until the process restarted.
 */

type Acquisition = { key: number; namespace: number | undefined }
const acquisitions: Acquisition[] = []
const releases: string[] = []
let grantLock = true
let lostAfterAcquire = false

mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    AdvisoryLockLostError: class AdvisoryLockLostError extends Error {},
    acquirePinnedAdvisoryLockOrNull: async (key: number, namespace?: number) => {
      acquisitions.push({ key, namespace })
      if (!grantLock) return null
      return {
        get lost() { return lostAfterAcquire },
        assertHeld(context?: string) {
          if (lostAfterAcquire) throw new Error(`Advisory lock was lost before ${context}`)
        },
        async release() { releases.push('released') },
      }
    },
  },
})

const load = async () => await import('@/lib/domain/accounting/money-post-lock')

const PAYLOAD = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 }
const DOCUMENT = {
  connector: 'xero',
  type: 'INVOICE_PAYMENT',
  referenceType: 'SalesOrder',
  referenceId: 'so-1',
  documentKey: 'INVOICE_PAYMENT inv-1 ',
}

function reset() {
  acquisitions.length = 0
  releases.length = 0
  grantLock = true
  lostAfterAcquire = false
}

test('the money-post lock is taken in its OWN namespace, on the DOCUMENT (o3d-0m56 r4/r6)', async () => {
  // Its own namespace on purpose: sharing the follow-up scope lock's would put every enqueue
  // TRANSACTION behind this lock's HTTP calls, which is longer than Prisma's transaction timeout —
  // the enqueue would not merely wait, it would abort.
  reset()
  const { withMoneyPostLock } = await load()
  const { ACCOUNTING_MONEY_POST_LOCK_NAMESPACE, ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE } = await import('@/lib/db/advisory-locks')
  const { moneyPostDocumentLockId } = await import('@/lib/domain/accounting/money-post-document')

  const outcome = await withMoneyPostLock(DOCUMENT, async () => 'posted')

  assert.deepEqual(outcome, { locked: true, result: 'posted' })
  assert.deepEqual(acquisitions, [{
    key: moneyPostDocumentLockId(DOCUMENT),
    namespace: ACCOUNTING_MONEY_POST_LOCK_NAMESPACE,
  }], 'keyed on the document the post will settle, not on where the row lives in IMS')
  assert.notEqual(ACCOUNTING_MONEY_POST_LOCK_NAMESPACE, ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE)
  assert.deepEqual(releases, ['released'])
})

test('a contended lock refuses immediately and runs nothing (o3d-0m56 r4)', async () => {
  // Waiting would only arrive at a ledger read that refuses. Refusing now returns the row to the
  // ordinary retry path, where it re-probes once the holder's payment is readable — and it means
  // nothing ever BLOCKS on this lock, so a holder needing a pooled connection cannot deadlock
  // against a queue of waiters.
  reset()
  grantLock = false
  const ran: string[] = []
  const outcome = await (await load()).withMoneyPostLock(DOCUMENT, async () => { ran.push('post'); return 'x' })

  assert.deepEqual(outcome, { locked: false })
  assert.deepEqual(ran, [], 'the holder is posting to this very document right now')
  assert.deepEqual(releases, [], 'and nothing is released that was never taken')
})

test('the lock is released when the run throws (o3d-0m56 r4)', async () => {
  reset()
  await assert.rejects(
    (await load()).withMoneyPostLock(DOCUMENT, async () => { throw new Error('Xero exploded') }),
    /Xero exploded/,
  )
  assert.deepEqual(releases, ['released'], 'however the run leaves, the lock does not stay held')
})

test('a run can tell the lock has been LOST under it (o3d-0m56 r4)', async () => {
  // PostgreSQL frees a session advisory lock the instant its connection dies. The run is handed
  // the lock, not a bare callback, precisely so the money post can check that before it calls.
  reset()
  lostAfterAcquire = true
  await assert.rejects(
    (await load()).withMoneyPostLock(DOCUMENT, async (held) => { held.assertHeld('posting'); return 'x' }),
    /Advisory lock was lost/,
  )
  assert.deepEqual(releases, ['released'])
})

test('two documents take two different locks (o3d-0m56 r4)', async () => {
  // Per document, deliberately: a lock coarse enough to serialize the whole connector would be a
  // throughput bug wearing a safety badge.
  const { moneyPostDocumentLockId, settlementDocumentKey } = await import('@/lib/domain/accounting/money-post-document')
  const id = moneyPostDocumentLockId(DOCUMENT)
  assert.notEqual(id, moneyPostDocumentLockId({ ...DOCUMENT, documentKey: settlementDocumentKey('INVOICE_PAYMENT', { accountingInvoiceId: 'inv-2' }) }))
  assert.notEqual(id, moneyPostDocumentLockId({ ...DOCUMENT, documentKey: settlementDocumentKey('BILL_PAYMENT', PAYLOAD) }))
  assert.notEqual(id, moneyPostDocumentLockId({ ...DOCUMENT, connector: 'quickbooks' }))
  // ...and two allocations DRAWN ON DIFFERENT CREDIT NOTES onto one bill are two legitimate
  // settlements, so they must not serialize against each other either.
  assert.notEqual(
    moneyPostDocumentLockId({ ...DOCUMENT, documentKey: settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'inv-1', creditNoteId: 'cn-1' }) }),
    moneyPostDocumentLockId({ ...DOCUMENT, documentKey: settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'inv-1', creditNoteId: 'cn-2' }) }),
  )
})

test('the SAME document in two different SCOPES is one lock (o3d-0m56 r6, CRITICAL 2)', async () => {
  // THE HOLE. Keyed on (connector, type, referenceType, referenceId), a bill payment queued
  // against the PurchaseOrder and one queued against the PurchaseInvoice took two different locks
  // for one bill, so both could be inside their probe→post span at the same time. The key is the
  // document now, so where the row happens to live in IMS cannot buy it a second exclusion.
  const { moneyPostDocumentLockId, settlementDocumentKey } = await import('@/lib/domain/accounting/money-post-document')
  const documentKey = settlementDocumentKey('BILL_PAYMENT', { accountingInvoiceId: 'bill-1' })
  assert.equal(
    moneyPostDocumentLockId({ connector: 'xero', type: 'BILL_PAYMENT', referenceType: 'PurchaseOrder', referenceId: 'po-1', documentKey }),
    moneyPostDocumentLockId({ connector: 'xero', type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'pi-9', documentKey }),
  )
})
