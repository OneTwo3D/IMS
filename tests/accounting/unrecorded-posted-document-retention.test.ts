import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  QBO_UNSETTLED_OPERATION_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import { DIRECT_CREATE_PENDING_ACTION } from '@/lib/fulfillment/pre-fulfilment-reallocation'

// ---------------------------------------------------------------------------
// Codex r2, medium 1 — THE SOLE RECORD OF A DOCUMENT THAT EXISTS IN XERO WAS BEING SWEPT.
//
// The conflict record says: this document was accepted by Xero and its sync row can never name it.
// Nothing re-derives it — the row names the other id and reads as settled — so it is the only place in
// IMS that the displaced document exists. It is written at level ERROR, and `purgeExpiredActivityLogs`
// deletes ERROR rows at 90 days by default. The branch exists to stop a real ledger document becoming
// permanently untracked; evidence that expires is the same defect one layer out.
//
// Three stores were rejected before this one: the mirrored AccountingEvent (its uniqueness is exactly
// what a duplicate collides on), AccountingSyncLog.errorMessage (a later legitimate re-record nulls it,
// and there is no row at all in the ROW_MISSING case), and ActivityLog under ordinary retention. What
// is left is ActivityLog NAMED IN THE SWEEP'S OWN EXEMPTION — enforced inside the DELETE predicate,
// which is the one place a sweep cannot route around.
// ---------------------------------------------------------------------------

type Query = { sql: string; values: unknown[] }

const captured: Query[] = []
const settings = new Map<string, string>()

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = settings.get(where.key)
          return value === undefined ? null : { value }
        },
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        captured.push({ sql: strings.join('?'), values })
        return [{ count: 0 }]
      },
    },
  },
})

async function purge() {
  captured.length = 0
  const { purgeExpiredActivityLogs } = await import('@/lib/activity-log-cleanup')
  return purgeExpiredActivityLogs()
}

test('Codex r2 medium 1: the retention sweep is told to keep the unrecorded-document record', async () => {
  await purge()

  const errorDelete = captured.find((query) => query.values[0] === 'ERROR')
  assert.ok(errorDelete, 'ERROR rows are swept, and that is the level this record is written at')
  const exempt = errorDelete.values.find((value): value is string[] => Array.isArray(value))
  assert.ok(exempt, 'the delete must carry an exemption list at all')
  assert.ok(
    exempt.includes(UNRECORDED_POSTED_DOCUMENT_ACTION),
    'the only local record of a document that exists in Xero must not be deleted by age',
  )
  // The pre-existing exemption is still there: this is an addition, not a replacement.
  assert.ok(exempt.includes(DIRECT_CREATE_PENDING_ACTION))
  assert.match(errorDelete.sql, /action <> ALL\(/, 'and <> ALL is what makes a two-entry list hold')
})

test('o3d-peh1 r5: the QuickBooks unrecorded-document record is exempt too, for the same reason', async () => {
  // The other way a real document ends up unreferenced: QuickBooks accepted the post and returned an
  // id, and the transaction that would have made it durable failed. The row names no document, so
  // nothing re-derives the identifier and no later sync attempt can — it exists only in this record,
  // written at ERROR, on the same 90-day sweep.
  await purge()

  const errorDelete = captured.find((query) => query.values[0] === 'ERROR')
  const exempt = errorDelete!.values.find((value): value is string[] => Array.isArray(value))
  assert.ok(
    exempt!.includes(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION),
    'the only local record of a document that exists in QuickBooks must not be deleted by age',
  )
  // A DISTINCT string, not a reuse: the operator reading it has to know which ledger to look in, and
  // an exemption only protects the spelling it was given.
  assert.notEqual(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION, UNRECORDED_POSTED_DOCUMENT_ACTION)
})

test('o3d-peh1 r6: the record of a no-id operation that could not be settled is exempt too', async () => {
  // A DIFFERENT kind-(2) incident on the same connector: an attachment, PDF, email or WooCommerce note
  // that ALREADY HAPPENED, on a row that could not be moved out of its claim. There is no external id
  // to escalate here — the record IS the whole account of it, and it is also the only notice that a
  // row is stuck. Ageing it out leaves a claimed row nobody knows to clear.
  await purge()

  const errorDelete = captured.find((query) => query.values[0] === 'ERROR')
  const exempt = errorDelete!.values.find((value): value is string[] => Array.isArray(value))
  assert.ok(
    exempt!.includes(QBO_UNSETTLED_OPERATION_ACTION),
    'the only record of a completed operation whose row is stuck must not be deleted by age',
  )
  // Distinct from BOTH document actions: this one is not about a document at all, and an operator
  // searching for it is asking a different question.
  assert.notEqual(QBO_UNSETTLED_OPERATION_ACTION, QBO_UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.notEqual(QBO_UNSETTLED_OPERATION_ACTION, UNRECORDED_POSTED_DOCUMENT_ACTION)
})

test('Codex r2 medium 1: the exemption is inside the DELETE, not applied afterwards', async () => {
  // A sweep that selected freely and filtered later would still delete the row on any path that skipped
  // the filter. The predicate and the exempt list have to be in the same statement.
  await purge()

  for (const query of captured) {
    assert.match(query.sql, /DELETE FROM "activity_logs"/)
    const listAt = query.values.findIndex((value) => Array.isArray(value))
    assert.notEqual(listAt, -1, 'the delete at every level carries the exemption, not just one of them')
    assert.ok(
      query.sql.indexOf('action <> ALL(') > query.sql.indexOf('DELETE FROM "activity_logs"'),
      'the exemption must sit in the deleting statement',
    )
  }
})

test('Codex r2 medium 1: a shortened ERROR retention still cannot reach it', async () => {
  // The setting is operator-controlled. Whatever it is set to, the exemption is not a function of it.
  settings.set('activity_log_retention_error', '1')
  const result = await purge()

  assert.equal(result.retention.ERROR, 1)
  const errorDelete = captured.find((query) => query.values[0] === 'ERROR')
  const exempt = errorDelete!.values.find((value): value is string[] => Array.isArray(value))
  assert.ok(exempt!.includes(UNRECORDED_POSTED_DOCUMENT_ACTION))
  settings.delete('activity_log_retention_error')
})
