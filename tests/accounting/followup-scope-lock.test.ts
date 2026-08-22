import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { ACCOUNTING_FOLLOWUP_SCOPE_LOCK_NAMESPACE, TWO_INT_ADVISORY_LOCK_NAMESPACES } from '@/lib/db/advisory-locks'
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

test('nothing but money pays for the lock (o3d-0m56)', async () => {
  // Ordinary queue traffic — invoices, journals, PDFs, emails — must not serialize on it.
  for (const type of ['SALES_INVOICE', 'INVOICE_PDF', 'INVOICE_EMAIL', 'COGS_JOURNAL', 'BILL_ATTACHMENT']) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.deepEqual(calls, [], `${type} must not take the lock`)
  }
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    const { tx, calls } = txDouble()
    await lockFollowUpScope(tx, { ...scope, type })
    assert.equal(calls.length, 1, `${type} must take it`)
  }
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
