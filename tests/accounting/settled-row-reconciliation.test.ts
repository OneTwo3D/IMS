import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { isMoneyMovingSyncType } from '@/lib/domain/accounting/followup-retry-guard'
import { decideSettledRowReconciliation } from '@/lib/domain/accounting/settled-row-reconciliation'

/**
 * o3d-0m56 round 3 (Codex, medium) — the exit from a correctly-refused money row.
 *
 * The rest of this issue is about refusing, and the refusals together produce a state with no way
 * out: a payment that reached the ledger but lost its response can never be retried (the ledger
 * holds it), never posts, and goes on blocking the next receipt for that order. The operator can
 * see exactly what happened and has no button that changes anything.
 *
 * The danger in the fix is obvious: a "mark as done" is a hole through every guard above it. So
 * this refuses unless IMS can SEE the settlement, and the tests here are mostly about the refusals.
 */

const args = { isMoneyMoving: isMoneyMovingSyncType }
const failedPayment = { status: 'FAILED', type: 'INVOICE_PAYMENT' }
const present = { outcome: 'present' as const, detail: '10.00 dated 2026-08-01 (PAY-1)', matchedId: 'PAY-1' }

test('a failed payment the ledger HOLDS can be closed, and records which settlement (o3d-0m56)', () => {
  const decision = decideSettledRowReconciliation({ ...args, row: failedPayment, settlement: present })
  assert.deepEqual(decision, { resolve: true, externalTransactionId: 'PAY-1', detail: present.detail })
})

test('a payment the ledger does NOT hold cannot be closed (o3d-0m56)', () => {
  // The refusal that matters. "It failed, just close it" is exactly what an operator will want to
  // do, and doing it leaves the document unpaid in the ledger with nothing in IMS still asking
  // anyone to look at it.
  const decision = decideSettledRowReconciliation({ ...args, row: failedPayment, settlement: { outcome: 'clear' } })
  assert.equal(decision.resolve, false)
  assert.match(decision.resolve === false ? decision.reason : '', /does NOT hold a payment/)
  assert.match(decision.resolve === false ? decision.reason : '', /Retry the entry instead/)
})

test('an unreadable ledger cannot close anything either (o3d-0m56)', () => {
  const decision = decideSettledRowReconciliation({
    ...args, row: failedPayment, settlement: { outcome: 'unknown', reason: 'HTTP 503' },
  })
  assert.equal(decision.resolve, false)
  assert.match(decision.resolve === false ? decision.reason : '', /HTTP 503/)
})

test('only a FAILED row, and only a payment, may be closed this way (o3d-0m56)', () => {
  // Every door into the sync log is a way to fake a success, so this one is as narrow as it can be.
  for (const status of ['PENDING', 'PROCESSING', 'SYNCED', 'CANCELLED']) {
    const decision = decideSettledRowReconciliation({ ...args, row: { status, type: 'INVOICE_PAYMENT' }, settlement: present })
    assert.equal(decision.resolve, false, status)
    assert.match(decision.resolve === false ? decision.reason : '', new RegExp(status))
  }
  for (const type of ['SALES_INVOICE', 'INVOICE_PDF', 'COGS_JOURNAL']) {
    const decision = decideSettledRowReconciliation({ ...args, row: { status: 'FAILED', type }, settlement: present })
    assert.equal(decision.resolve, false, type)
    assert.match(decision.resolve === false ? decision.reason : '', /Only a payment entry/)
  }
  assert.equal(
    decideSettledRowReconciliation({ ...args, row: null, settlement: present }).resolve,
    false,
    'and a row that has gone is not a row that can be closed',
  )
})

test('the action reads the ledger, then writes under the scope lock, fenced on FAILED (o3d-0m56)', async () => {
  const source = await readFile(path.join(process.cwd(), 'app/actions/accounting-sync.ts'), 'utf8')
  const at = source.indexOf('export async function reconcileSettledAccountingSyncRow')
  assert.notEqual(at, -1, 'the exit must exist')
  const body = source.slice(at, source.indexOf('\n}\n', at))

  assert.match(body, /await requirePermission\('settings'\)/, 'it changes accounting state; it is permissioned')
  const probeAt = body.indexOf('probeLedgerSettlement')
  const txAt = body.indexOf('db.$transaction')
  assert.ok(probeAt !== -1 && txAt > probeAt, 'the ledger is read BEFORE the transaction, never inside it')
  assert.match(body, /await lockFollowUpScope\(tx, \{/, 'and the write takes the scope lock')
  assert.match(body, /where: \{ id: entryId, status: 'FAILED' \}/, 'fenced on FAILED, so it cannot resolve a live row')
  assert.match(body, /status: 'SYNCED'/)
  assert.match(body, /externalTransactionId: decision\.externalTransactionId/, 'the matched settlement is recorded')
  assert.match(body, /action: 'accounting_sync_row_reconciled'/, 'and the whole thing is audited')
})

test('the sync page offers it for exactly the money types (o3d-0m56)', async () => {
  // A type shown but refused by the server is a button that only ever errors; a type missing is a
  // wedged row with no exit.
  const client = await readFile(path.join(process.cwd(), 'app/(dashboard)/sync/xero-client.tsx'), 'utf8')
  const at = client.indexOf('const MONEY_SYNC_TYPES = new Set(')
  assert.notEqual(at, -1, 'the client must say which rows it offers this for')
  const listed = [...client.slice(at, client.indexOf('])', at)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
  assert.ok(listed.length > 0)
  for (const type of listed) assert.equal(isMoneyMovingSyncType(type), true, `${type} must be a money type`)
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    assert.ok(listed.includes(type), `${type} must be offered, or its rows have no exit`)
  }
  assert.match(client, /reconcileSettledAccountingSyncRow\(entryId\)/, 'and it must call the action')
})
