import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r2 finding 2 — retention deletes accounting_sync_logs by AGE, on its own schedule,
// while the back-reference sweep reads its candidate page outside the transaction that later
// acts on it. Deleting an UNRESOLVED row in that window does not merely lose an audit trail:
//
//   • deleting the row being repaired leaves the sweep holding an external id whose evidence is
//     gone (the resolver now refuses that — "exactly one live sync row");
//   • deleting a COMPETING SIBLING is worse, because it is undetectable. One unlinked bill and
//     one surviving claimant is genuinely indistinguishable from an unambiguous attribution, so
//     the sweep stops refusing and stamps a bill whose competitor no longer exists.
//
// The predicate is therefore asserted BEHAVIOURALLY — the where clause is evaluated against rows
// — rather than by comparing its shape, so a version of production that kept the constant but
// stopped applying it, or applied it with the wrong polarity, fails here.
// ---------------------------------------------------------------------------

type DeleteArgs = { where: Record<string, unknown> }

const capture: { settingRows: Array<{ key: string; value: string }>; accountingDelete?: DeleteArgs } = {
  settingRows: [],
  accountingDelete: undefined,
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityPersisted: async () => true } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: {
        ...noopDelegate(),
        deleteMany: async (args: DeleteArgs) => {
          capture.accountingDelete = args
          return { count: 0 }
        },
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
    },
  },
})

type Row = Record<string, unknown>

/** Enough of Prisma's where semantics for this predicate — including NOT(AND(...)). */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
      continue
    }
    const value = row[key] ?? null
    if (condition === null) {
      if (value !== null) return false
      continue
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      const operators = condition as Record<string, unknown>
      const unsupported = Object.keys(operators).filter((op) => !['in', 'not', 'lt'].includes(op))
      if (unsupported.length > 0) throw new Error(`unsupported operator(s) ${unsupported.join(', ')} on "${key}"`)
      if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false
      if ('not' in operators) {
        if (operators.not === null) { if (value === null) return false } else if (value === operators.not) return false
      }
      if ('lt' in operators) {
        if (!(value instanceof Date) || !(operators.lt instanceof Date) || value.getTime() >= operators.lt.getTime()) return false
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

const OLD = new Date('2020-01-01T00:00:00Z')
const NOW = new Date()

function row(overrides: Row = {}): Row {
  return {
    id: 'log-1',
    createdAt: OLD,
    type: 'PURCHASE_INVOICE',
    status: 'SYNCED',
    externalTransactionId: 'XBILL-1',
    backReferenceCheckedAt: null,
    ...overrides,
  }
}

/** Out of line so the assignment does not narrow `capture.accountingDelete` to `undefined`. */
function resetCapturedDelete(): void {
  capture.accountingDelete = undefined
}

async function captureDeletePredicate(): Promise<Record<string, unknown>> {
  const { purgeExpiredData } = await import('@/lib/data-retention')
  capture.settingRows = [{ key: 'retention_sync_logs_months', value: '6' }]
  resetCapturedDelete()
  await purgeExpiredData()
  assert.ok(capture.accountingDelete, 'retention must still delete expired accounting sync logs')
  return capture.accountingDelete.where
}

test('[o3d-9kek r2 f2] retention keeps UNRESOLVED back-reference evidence past the cutoff', async () => {
  const where = await captureDeletePredicate()

  // The row under repair, and — the case that actually corrupts data — its competing sibling.
  // Deleting either one silently converts a refusal into a confident wrong answer.
  assert.equal(matches(row({ id: 'legacy' }), where), false)
  assert.equal(matches(row({ id: 'sibling', externalTransactionId: 'XBILL-2' }), where), false)
  // FAILED rows are candidates too (they may still owe their follow-ups).
  assert.equal(matches(row({ status: 'FAILED' }), where), false)
  // ...and so are the sales-side types the sweep repairs.
  assert.equal(matches(row({ type: 'SALES_INVOICE' }), where), false)
  assert.equal(matches(row({ type: 'CREDIT_NOTE' }), where), false)
})

test('[o3d-9kek r2 f2] retention still deletes everything the sweep has SETTLED or never owned', async () => {
  const where = await captureDeletePredicate()

  // The exemption is bounded by the sweep's own verdict marker: once a row is settled, the
  // attribution lives on the document (which is never retention-deleted, and now unique), so the
  // log is free to expire. Without this the exemption would grow without limit.
  assert.equal(matches(row({ backReferenceCheckedAt: new Date('2021-01-01') }), where), true)
  // Never posted — it is not evidence of anything in the ledger.
  assert.equal(matches(row({ externalTransactionId: null }), where), true)
  // Deliberately abandoned (audit-46ry), and types that carry no back-reference at all.
  assert.equal(matches(row({ status: 'CANCELLED' }), where), true)
  assert.equal(matches(row({ type: 'COGS_JOURNAL' }), where), true)
  assert.equal(matches(row({ type: 'INVOICE_PAYMENT' }), where), true)
  // Age is still the primary rule: nothing inside the retention window is deleted.
  assert.equal(matches(row({ createdAt: NOW }), where), false)
})
