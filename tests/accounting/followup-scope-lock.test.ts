import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE, TWO_INT_ADVISORY_LOCK_NAMESPACES } from '@/lib/db/advisory-locks'
import { MIRRORED_ACCOUNTING_SYNC_TYPES } from '@/lib/domain/accounting/mirrored-sync-types'
import { followUpScopeLockId, lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'

/**
 * o3d-0m56 (Codex finding 3) — the manual retry decides from a snapshot and writes afterwards.
 * Between the two, another writer can queue a row for the same document under a fresh token, and
 * that row can reach FAILED before the reset lands: the retry then revives beside a second token
 * it never saw, and both can post.
 *
 * A row lock cannot close that — PostgreSQL has no predicate locks, so `FOR UPDATE` says nothing
 * about a row that does not exist yet. Only a lock BOTH sides take does, which is what this is,
 * and it is worth nothing unless every writer that can create a money row actually takes it. So
 * the semantics are tested here and each call site is pinned below.
 */

function txDouble() {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values })
      return 1
    },
  }
  return { tx: tx as never, calls }
}

const scope = { connector: 'xero', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1' }

test('a money-moving scope is locked to COMMIT, in its own namespace (o3d-0m56)', async () => {
  const { tx, calls } = txDouble()
  await lockFollowUpScope(tx, scope)

  assert.equal(calls.length, 1)
  // _xact_, not a session lock: the whole point is that the decision and the write that follows it
  // are indivisible to every other writer, which means holding it until the transaction commits.
  assert.match(calls[0]!.sql, /pg_advisory_xact_lock/)
  assert.deepEqual(calls[0]!.values, [ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE, followUpScopeLockId(scope)])
})

test('money AND mirrored types pay for the lock; nothing else does (o3d-11rf)', async () => {
  // o3d-11rf WIDENED THIS. The rule used to be "money only", and `SALES_INVOICE` was pinned right
  // here as a type that must NOT take the lock. That was correct for the race o3d-0m56 closed (two
  // money rows for one document) and wrong for the one o3d-11rf found, because a MIRRORED type
  // shares one logical accounting-event mirror across every attempt at the same document — and the
  // settlement action decides whether to VOID that mirror by reading its siblings. A read cannot be
  // serialised against an INSERT by a row lock, so both sides have to take this.
  //
  // The two sets are DISJOINT: MONEY_MOVING_SYNC_TYPES is {INVOICE_PAYMENT, BILL_PAYMENT,
  // PURCHASE_CREDIT_NOTE_ALLOCATION} and none of those is mirrored. So before o3d-11rf this lock
  // was taken for exactly no mirrored type, and "settlement takes the same lock the enqueue takes"
  // would have serialised NOTHING.
  for (const type of ['INVOICE_PDF', 'INVOICE_EMAIL', 'COGS_JOURNAL', 'BILL_ATTACHMENT', 'WC_INVOICE_NOTE']) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.deepEqual(calls, [], `${type} must not take the lock`)
  }
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.equal(calls.length, 1, `${type} must take it`)
  }
  for (const type of ['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE']) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.equal(calls.length, 1, `${type} is mirrored, so it must take it (o3d-11rf)`)
  }
})

/**
 * TOTALITY, so the two rules cannot drift apart. The mirror's type list is maintained in
 * accounting-event-mirror.ts and grows (six DAILY_BATCH_* variants have been added to it since it
 * was written). A type added there but not covered here would be a mirrored document whose
 * settlement and enqueue do not serialise — the o3d-11rf defect, silently reintroduced for one
 * type. Derived from the exported list rather than restated, and asserted through the REAL lock
 * rather than through the predicate alone, so it pins what actually reaches PostgreSQL.
 */
test('EVERY mirrored sync type takes the scope lock (o3d-11rf)', async () => {
  assert.ok(MIRRORED_ACCOUNTING_SYNC_TYPES.length >= 13, 'the mirrored list should not have shrunk to nothing')
  for (const type of MIRRORED_ACCOUNTING_SYNC_TYPES) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.equal(calls.length, 1, `${type} is mirrored and must take the scope lock`)
    assert.deepEqual(calls[0]!.values, [
      ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE,
      followUpScopeLockId({ ...scope, type }),
    ], `${type} must lock its OWN scope`)
  }
})

test('the money and mirrored type sets are disjoint — this is why widening was needed (o3d-11rf)', () => {
  // Recorded as an assertion because the whole argument for the change rests on it. If a type ever
  // becomes both, the widening is still correct; but the reasoning above stops being the reason.
  const money = ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']
  const both = MIRRORED_ACCOUNTING_SYNC_TYPES.filter((type) => money.includes(type))
  assert.deepEqual(both, [], 'no mirrored type was money-moving, so the money gate covered none of them')
})

test('the lock id is per document, stable, and a signed int32 (o3d-0m56)', async () => {
  // Two different documents contending would be a silent performance bug; the SAME document not
  // contending would be a silent correctness one.
  assert.equal(followUpScopeLockId(scope), followUpScopeLockId({ ...scope }))
  for (const different of [
    { ...scope, connector: 'quickbooks' },
    { ...scope, type: 'BILL_PAYMENT' },
    { ...scope, referenceType: 'PurchaseInvoice' },
    { ...scope, referenceId: 'so-2' },
  ]) {
    assert.notEqual(followUpScopeLockId(scope), followUpScopeLockId(different), JSON.stringify(different))
  }
  const id = followUpScopeLockId(scope)
  assert.ok(Number.isInteger(id) && id >= -(2 ** 31) && id < 2 ** 31, `pg needs an int4, got ${id}`)
})

test('the namespace is registered, so a future lock cannot silently collide with it (o3d-0m56)', () => {
  assert.equal(
    TWO_INT_ADVISORY_LOCK_NAMESPACES.ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE,
    ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE,
  )
})

/**
 * Every writer that can create or revive a money-moving row. A lock one of them skips is not a
 * weaker lock — it is no lock at all for that pair, so the list is pinned rather than trusted.
 */
const WRITERS = [
  { file: 'lib/accounting.ts', what: 'the shared in-transaction queue (addPayment, markBillPaid)' },
  { file: 'lib/connectors/xero/queue.ts', what: "Xero's own queue" },
  { file: 'lib/connectors/quickbooks/queue.ts', what: "QuickBooks' own queue" },
  { file: 'lib/connectors/xero/sync-processor.ts', what: "Xero's follow-up enqueue" },
  { file: 'lib/connectors/quickbooks/sync-processor.ts', what: "QuickBooks' follow-up enqueue" },
  { file: 'app/actions/xero-sync.ts', what: 'the Xero manual retry' },
  { file: 'app/actions/quickbooks-sync.ts', what: 'the QuickBooks manual retry' },
]

for (const writer of WRITERS) {
  test(`${writer.file} takes the scope lock — ${writer.what} (o3d-0m56)`, async () => {
    const source = await readFile(path.join(process.cwd(), writer.file), 'utf8')
    assert.match(source, /import \{ lockFollowUpScope \} from '@\/lib\/domain\/accounting\/followup-scope-lock'/)
    assert.match(source, /await lockFollowUpScope\(tx, \{/, `${writer.what} must take it inside a transaction`)
  })
}
