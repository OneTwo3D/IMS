import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { settlementDocumentKey } from '@/lib/domain/accounting/money-post-document'

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
  // Built by the production key function rather than written out. A hand-written key is a double
  // with a false premise: it can stay valid while the real key changes shape underneath it, and
  // then every lock-identity assertion below is about a string nothing produces.
  documentKey: settlementDocumentKey('INVOICE_PAYMENT', PAYLOAD),
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

test('one document id in TWO CASES is ONE lock (o3d-0m56 r7, HIGH 2)', async () => {
  // A Xero document id is a GUID, and `4D8A…` addresses the invoice `4d8a…` addresses — the
  // allocation probe has always compared them with `toLowerCase`. A case-SENSITIVE key therefore
  // handed one document two locks, which is the cross-scope double post the document key was
  // written to close, reopened one spelling later.
  const { moneyPostDocumentLockId } = await import('@/lib/domain/accounting/money-post-document')
  const lower = settlementDocumentKey('BILL_PAYMENT', { accountingInvoiceId: '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44' })
  const upper = settlementDocumentKey('BILL_PAYMENT', { accountingInvoiceId: '4D8A1F2E-0000-4C11-9A3B-7E5D2C9B1A44' })
  assert.equal(lower, upper, 'case is not part of a document\'s identity')
  assert.equal(
    moneyPostDocumentLockId({ connector: 'xero', type: 'BILL_PAYMENT', referenceType: 'PurchaseOrder', referenceId: 'po-1', documentKey: lower }),
    moneyPostDocumentLockId({ connector: 'xero', type: 'BILL_PAYMENT', referenceType: 'PurchaseInvoice', referenceId: 'pi-9', documentKey: upper }),
  )
  // ...and the credit note half of the key folds too, or an allocation gets the same second lock.
  assert.equal(
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'bill-1', creditNoteId: 'CN-1' }),
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'BILL-1', creditNoteId: 'cn-1' }),
  )
})

test('the key cannot run two DIFFERENT documents together (o3d-0m56 r7, HIGH 2)', async () => {
  // The other direction, because folding case is only safe if it stays injective. It is, over the
  // alphabets either connector issues — and the parts are delimited, so an id that contains the
  // separator cannot borrow the next field's value. Delimited as one space, these two were the
  // SAME key, and this value caches the probe as well as keying the lock: a collision hands one
  // document the other's ledger reading, which is a false clear.
  assert.notEqual(
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a b', creditNoteId: 'c' }),
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'a', creditNoteId: 'b c' }),
  )
  assert.notEqual(
    settlementDocumentKey('BILL_PAYMENT', { accountingInvoiceId: '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a44' }),
    settlementDocumentKey('BILL_PAYMENT', { accountingInvoiceId: '4d8a1f2e-0000-4c11-9a3b-7e5d2c9b1a45' }),
  )
})

test('an irrelevant creditNoteId does not SPLIT a payment\'s lock (o3d-0m56 r9, HIGH 1)', async () => {
  // THE HOLE. The key was the UNION of every anchor a money payload can hold, whatever the type.
  // For a PAYMENT `creditNoteId` is not part of the document at all — it is in no payment body
  // either connector sends, and neither probe dereferences it on a payment branch — so a payment
  // row that happened to carry one keyed a DIFFERENT document from a payment row that did not.
  // Two locks on one invoice, two cached ledger readings, two contender sets: the cross-scope
  // double post the document key was written to close, reopened by an irrelevant field. `payload`
  // is untyped JSON IMS does not validate on the way in, so "nothing writes it today" is a claim
  // about the current call sites, not about the data.
  const { moneyPostDocumentLockId } = await import('@/lib/domain/accounting/money-post-document')
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT']) {
    const bare = settlementDocumentKey(type, { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10 })
    const carrying = settlementDocumentKey(type, { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10, creditNoteId: 'cn-9' })
    assert.equal(bare, carrying, `${type}: a payment is identified by the document it pays, and by nothing else`)
    assert.equal(
      moneyPostDocumentLockId({ connector: 'xero', type, referenceType: 'SalesOrder', referenceId: 'so-1', documentKey: bare }),
      moneyPostDocumentLockId({ connector: 'xero', type, referenceType: 'PurchaseInvoice', referenceId: 'pi-1', documentKey: carrying }),
      `${type}: one document, one lock, whatever else the payload happens to hold`,
    )
  }
  // The other direction, and it is why the rule is per TYPE rather than "drop creditNoteId": for an
  // ALLOCATION the credit note IS half the document, so it must still key and still split.
  assert.notEqual(
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'bill-1', creditNoteId: 'cn-1' }),
    settlementDocumentKey('PURCHASE_CREDIT_NOTE_ALLOCATION', { accountingInvoiceId: 'bill-1' }),
    'an allocation is identified by the PAIR — dropping the anchor would merge two real documents',
  )
})

test('every money-moving type states its anchors EXPLICITLY (o3d-0m56 r9, HIGH 1)', async () => {
  // The rule is per type, so the danger is a NEW money type inheriting the default. The default is
  // the invoice alone: for a type identified by a pair that would hand two real documents one
  // cached ledger reading, which is a false clear rather than merely extra serialization. Adding a
  // money type without deciding its anchors has to fail here rather than in the ledger.
  const { documentAnchorFields, hasExplicitDocumentAnchors } = await import('@/lib/domain/accounting/money-post-document')
  const { MONEY_MOVING_SYNC_TYPES, attemptCouldHaveReachedTheLedger } = await import('@/lib/domain/accounting/followup-retry-guard')

  // Every required id field of all three money types at once, so one fixture is postable as any of
  // them and blanking a field is the only thing that changes the answer below.
  const FULL = { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', creditNoteId: 'cn-1', amount: 10 }
  assert.ok(MONEY_MOVING_SYNC_TYPES.size > 0)
  for (const type of MONEY_MOVING_SYNC_TYPES) {
    assert.ok(hasExplicitDocumentAnchors(type), `${type} moves money and has no explicit anchor rule`)
    const anchors = documentAnchorFields(type)
    assert.ok(anchors.length > 0, `${type} must be identified by something`)
    assert.ok(attemptCouldHaveReachedTheLedger(type, FULL), `${type}: the fixture must be a body that could post`)
    // AND EVERY ANCHOR MUST BE A FIELD THE CONNECTOR REQUIRES. That is what makes the key sound in
    // both directions: a row missing an anchor provably never posted (so nothing is keyed on a
    // value a real attempt could have omitted), and an anchor cannot be a decorative field like
    // `creditNoteId` on a payment, which is what produced the split.
    for (const anchor of anchors) {
      assert.equal(
        attemptCouldHaveReachedTheLedger(type, { ...FULL, [anchor]: '' }), false,
        `${type} is keyed on ${anchor}, so a body without it must be one the connector refuses to send`,
      )
    }
  }
})
