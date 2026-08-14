import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// o3d-ahk: purgeExpiredData COMPACTS succeeded shopping-webhook-inbox rows past the cutoff — it clears
// the bulky payloadJson but KEEPS the row (the connector/resource/payloadHash idempotency tombstone).
// DEAD_LETTER (unresolved) and PENDING/FAILED (undelivered) are left fully intact.
//
// o3d-nepa: the accountingSyncLog branch gets the same treatment, on a THREE-CASE rule keyed on
// resolvedAt (when the row RESOLVED) rather than createdAt (when it was queued):
//   1. unresolved (PENDING/PROCESSING) — never deleted, never compacted, at any age;
//   2. CANCELLED with no externalTransactionId past the cutoff — deleted (no remote effect, and the
//      order delete guard cannot see such a row anyway);
//   3. every other expired terminal row — COMPACTED to a posting tombstone: the guard's fields stay,
//      the payload is cut down to its idempotency TOKENS (never nulled — a FAILED row that reads as
//      "no token" can rotate a money-moving remote key), errorMessage becomes a non-PII marker.
// The delegate below is a real fake rather than the previous noop, so all of that is actually pinned.

type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> }
type FindManyArgs = { where: Record<string, unknown>; take?: number }

type AccountingRow = {
  id: string
  status: string
  type: string
  externalTransactionId: string | null
  payload: unknown
  errorMessage: string | null
  resolvedAt: Date | null
  createdAt: Date
  compactedAt: Date | null
}

const capture: { settingRows: Array<{ key: string; value: string }>; last?: UpdateArgs; count: number } = {
  settingRows: [],
  last: undefined,
  count: 0,
}

/**
 * In-memory AccountingSyncLog. `deleteMany`/`findMany` evaluate the production `where` against the
 * seeded rows, so the tests exercise the real predicate rather than asserting on its shape.
 */
const accounting: { rows: AccountingRow[]; deleted: string[]; updates: UpdateArgs[] } = {
  rows: [],
  deleted: [],
  updates: [],
}

function row(overrides: Partial<AccountingRow> & { id: string }): AccountingRow {
  const seeded: AccountingRow = {
    status: 'SYNCED',
    type: 'SALES_INVOICE',
    externalTransactionId: null,
    payload: null,
    errorMessage: null,
    resolvedAt: null,
    createdAt: new Date(),
    compactedAt: null,
    ...overrides,
  }
  // A row is always CREATED before it RESOLVES, so an unstated createdAt tracks resolvedAt. Seeding
  // `createdAt: now` alongside `resolvedAt: three years ago` would be impossible in production and
  // would make these tests fail against a createdAt-keyed implementation for the wrong reason —
  // masking which assertion actually pins the resolvedAt rule.
  return { ...seeded, createdAt: overrides.createdAt ?? seeded.resolvedAt ?? seeded.createdAt }
}

const YEARS_AGO = new Date(Date.now() - 3 * 365 * 24 * 3600_000)
const MINUTES_AGO = new Date(Date.now() - 5 * 60_000)

/** Minimal evaluator for the Prisma `where` shapes this branch uses. */
function matchesWhere(target: AccountingRow, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matchesWhere(target, clause))) return false
      continue
    }
    if (key === 'NOT') {
      if (matchesWhere(target, condition as Record<string, unknown>)) return false
      continue
    }
    const value = (target as unknown as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const op = condition as Record<string, unknown>
      if ('lt' in op && !(value instanceof Date && value < (op.lt as Date))) return false
      if ('in' in op && !(op.in as unknown[]).includes(value)) return false
      if ('notIn' in op && (op.notIn as unknown[]).includes(value)) return false
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => capture.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: {
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const hit = accounting.rows.filter((candidate) => matchesWhere(candidate, where))
          accounting.deleted.push(...hit.map((candidate) => candidate.id))
          accounting.rows = accounting.rows.filter((candidate) => !hit.includes(candidate))
          return { count: hit.length }
        },
        findMany: async ({ where, take }: FindManyArgs) => {
          const hit = accounting.rows.filter((candidate) => matchesWhere(candidate, where))
          return (typeof take === 'number' ? hit.slice(0, take) : hit)
            .map((candidate) => ({ id: candidate.id, payload: candidate.payload, errorMessage: candidate.errorMessage }))
        },
        update: async (args: UpdateArgs) => {
          accounting.updates.push(args)
          const target = accounting.rows.find((candidate) => candidate.id === (args.where as { id: string }).id)
          if (target) Object.assign(target, args.data)
          return target
        },
        updateMany: async () => {
          throw new Error('accounting rows are compacted per-row (each keeps its OWN tokens), never in bulk')
        },
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: {
        deleteMany: async () => {
          throw new Error('inbox rows must be COMPACTED, never deleted (dedup + audit)')
        },
        updateMany: async (args: UpdateArgs) => {
          capture.last = args
          return { count: capture.count }
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

/** Seed the accounting fake and run the sync-log branch with a 6-month window. */
async function runAccountingCleanup(rows: AccountingRow[], months = '6') {
  const purgeExpiredData = await loadPurge()
  accounting.rows = rows
  accounting.deleted = []
  accounting.updates = []
  capture.settingRows = [{ key: 'retention_sync_logs_months', value: months }]
  capture.last = undefined
  capture.count = 0
  return purgeExpiredData()
}

function updateFor(id: string): UpdateArgs {
  const found = accounting.updates.find((args) => (args.where as { id: string }).id === id)
  if (!found) throw new Error(`row ${id} was not compacted`)
  return found
}

test('compacts ONLY PROCESSED rows past the cutoff, clearing payloadJson but keeping the row (o3d-ahk)', async () => {
  const purgeExpiredData = await loadPurge()
  accounting.rows = []
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.count = 7

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 7)
  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  // Only succeeded rows — never DEAD_LETTER (audit) or PENDING/FAILED (undelivered).
  assert.equal(args.where.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.notEqual(args.where.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.ok((args.where.updatedAt as { lt?: Date })?.lt instanceof Date, 'bounded by an updatedAt cutoff')
  // Already-compacted rows are permanently excluded so each run only touches the newly-eligible set.
  assert.deepEqual((args.where.NOT as { payloadJson?: { equals?: unknown } })?.payloadJson?.equals, {})
  // Clears the bulky payload, keeps the row (dedup key + status untouched).
  assert.deepEqual(args.data.payloadJson, {})
  assert.equal(args.data.lastError, null)
  assert.equal(args.data.status, undefined, 'status is preserved, not changed')
})

test('a 0-month webhook retention setting disables compaction', async () => {
  const purgeExpiredData = await loadPurge()
  accounting.rows = []
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '0' }]
  capture.last = undefined
  capture.count = 99

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 0)
  assert.equal(capture.last, undefined, 'updateMany must not be called when retention is 0')
})

// ---------------------------------------------------------------------------
// o3d-nepa — accounting sync log retention
// ---------------------------------------------------------------------------

test('o3d-nepa headline: a long-expired row that terminalises just before cleanup SURVIVES', async () => {
  // The exact defect: created three years ago, resolved five minutes ago. Keying on createdAt
  // destroyed it on the very next run — with it, the delete guard's only evidence that a FAILED
  // QuickBooks invoice may exist in the ledger (o3d-ju8t / o3d-0g2n).
  const result = await runAccountingCleanup([
    row({ id: 'just-resolved', status: 'FAILED', createdAt: YEARS_AGO, resolvedAt: MINUTES_AGO, errorMessage: 'boom' }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [], 'a freshly-resolved row is not compacted either')
})

test('o3d-nepa case 1: an unresolved PENDING/PROCESSING row is never deleted or compacted, at any age', async () => {
  // Unresolved means unresolved. A PROCESSING claim may already have posted with no external id
  // (o3d-sref), and live payloads are read back by the FX revaluation, refund-service's
  // double-reversal guard and followup-revival — forgetting one changes what the next journal posts.
  const result = await runAccountingCleanup([
    row({ id: 'ancient-pending', status: 'PENDING', createdAt: YEARS_AGO, payload: { customerEmail: 'a@b.c' } }),
    row({ id: 'ancient-processing', status: 'PROCESSING', createdAt: YEARS_AGO, payload: { customerEmail: 'a@b.c' } }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [])
  assert.equal(accounting.rows.length, 2, 'both rows survive intact')
})

test('o3d-nepa case 2: CANCELLED with NO external id past the cutoff is deleted', async () => {
  const result = await runAccountingCleanup([
    row({ id: 'inert', status: 'CANCELLED', externalTransactionId: null, resolvedAt: YEARS_AGO, errorMessage: 'retired' }),
  ])

  assert.equal(result.accountingSyncLogsDeleted, 1)
  assert.deepEqual(accounting.deleted, ['inert'])
  assert.equal(result.accountingSyncLogsCompacted, 0, 'a deleted row must not also be compacted')
})

test('o3d-nepa case 3: CANCELLED WITH an external id is compacted, never deleted', async () => {
  // Xero reverts an already-posted row to PENDING when follow-up work fails, KEEPING the external id,
  // and the orphan sweep can then move that row to CANCELLED without clearing it. The delete guard
  // matches it via `externalTransactionId IS NOT NULL`, so deleting it strands a real document.
  const result = await runAccountingCleanup([
    row({ id: 'posted-then-cancelled', status: 'CANCELLED', externalTransactionId: 'INV-9', resolvedAt: YEARS_AGO }),
  ])

  assert.deepEqual(accounting.deleted, [], 'a posted document is never deleted')
  assert.equal(result.accountingSyncLogsCompacted, 1)
  assert.equal(accounting.rows[0].externalTransactionId, 'INV-9', 'the guard still sees the posted id')
})

test('o3d-nepa case 3: an expired FAILED row keeps its follow-up idempotency token and loses the rest', async () => {
  // A nulled payload reads as "no token" to planFollowUpEnqueue, which either rotates the remote key
  // (a SECOND payment against the same invoice) or flips an INVOICE_PAYMENT plan to `refuse`. So
  // compaction REDUCES the payload to its tokens instead of clearing it (o3d-h2wx).
  const result = await runAccountingCleanup([
    row({
      id: 'failed-payment',
      status: 'FAILED',
      type: 'INVOICE_PAYMENT',
      resolvedAt: YEARS_AGO,
      errorMessage: 'Xero: contact Jane Doe <jane@example.com> is archived',
      payload: {
        _followUpIdempotencyKey: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:',
        _idempotencyKey: 'invoice-payment:payment:pay_1',
        accountingInvoiceId: 'INV-9',
        amount: 129.99,
        contactEmail: 'jane@example.com',
        lines: [{ description: 'Widget', unitAmount: 129.99 }],
      },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 1)
  const { data } = updateFor('failed-payment')
  assert.deepEqual(data.payload, {
    _idempotencyKey: 'invoice-payment:payment:pay_1',
    _followUpIdempotencyKey: 'followup:xero:INVOICE_PAYMENT:SalesOrder:so_1:INV-9:',
  }, 'ONLY the two idempotency tokens survive')
  // Personal and financial detail is gone; the connector's error text (which quotes contact names
  // back at us) is replaced by a marker rather than nulled, so the rejected-sync warning stays honest.
  assert.equal(data.errorMessage, 'Detail removed by data retention (o3d-nepa).')
  assert.ok(data.compactedAt instanceof Date)
})

test('o3d-nepa case 3: an expired SYNCED row is compacted and keeps its externalTransactionId', async () => {
  const result = await runAccountingCleanup([
    row({
      id: 'synced',
      status: 'SYNCED',
      externalTransactionId: 'xero-abc',
      resolvedAt: YEARS_AGO,
      payload: { contactName: 'Jane Doe', lines: [{ unitAmount: 10 }] },
    }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 1)
  assert.deepEqual(accounting.deleted, [])
  const { data } = updateFor('synced')
  assert.deepEqual(data.payload, {}, 'no tokens on this row, so nothing survives the payload')
  assert.equal(data.errorMessage, null, 'a row that never errored keeps its clean null')
  assert.equal(accounting.rows[0].externalTransactionId, 'xero-abc')
  assert.equal(accounting.rows[0].status, 'SYNCED', 'status is evidence — never rewritten')
})

test('o3d-nepa: a second run does not re-compact an already-compacted row', async () => {
  // compactedAt is the idempotence guard — the same job `NOT payloadJson = {}` does for the webhook
  // inbox — so each nightly run touches only the newly-eligible set.
  await runAccountingCleanup([
    row({ id: 'synced', status: 'SYNCED', resolvedAt: YEARS_AGO, payload: { contactName: 'Jane Doe' } }),
  ])
  assert.equal(accounting.updates.length, 1)

  const carried = accounting.rows
  const purgeExpiredData = await loadPurge()
  accounting.updates = []
  const second = await purgeExpiredData()

  assert.equal(second.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.updates, [], 'no write on the second pass')
  assert.ok(carried[0].compactedAt instanceof Date)
})

test('o3d-nepa: a 0-month sync-log setting disables the whole accounting branch', async () => {
  const result = await runAccountingCleanup([
    row({ id: 'inert', status: 'CANCELLED', resolvedAt: YEARS_AGO }),
    row({ id: 'synced', status: 'SYNCED', resolvedAt: YEARS_AGO, payload: { contactName: 'Jane Doe' } }),
  ], '0')

  assert.equal(result.accountingSyncLogsDeleted, 0)
  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.deleted, [])
  assert.deepEqual(accounting.updates, [])
})

test('o3d-nepa: a pre-migration row (resolvedAt NULL) falls back to createdAt, and only for the safe cases', async () => {
  // NULL must mean neither "expired long ago" nor "never expires". createdAt is a LOWER bound on
  // resolvedAt, and both branches it feeds are non-destructive of guard evidence — deletion is
  // limited to rows the guard cannot see, compaction keeps every field it reads.
  const result = await runAccountingCleanup([
    row({ id: 'legacy-cancelled', status: 'CANCELLED', createdAt: YEARS_AGO, resolvedAt: null }),
    row({ id: 'legacy-synced', status: 'SYNCED', createdAt: YEARS_AGO, resolvedAt: null, externalTransactionId: 'x1' }),
    row({ id: 'legacy-pending', status: 'PENDING', createdAt: YEARS_AGO, resolvedAt: null }),
    row({ id: 'recent-synced', status: 'SYNCED', createdAt: MINUTES_AGO, resolvedAt: null }),
  ])

  assert.deepEqual(accounting.deleted, ['legacy-cancelled'])
  assert.equal(result.accountingSyncLogsCompacted, 1)
  updateFor('legacy-synced')
  assert.ok(accounting.rows.some((candidate) => candidate.id === 'legacy-pending' && candidate.compactedAt === null))
  assert.ok(accounting.rows.some((candidate) => candidate.id === 'recent-synced' && candidate.compactedAt === null))
})

test('o3d-nepa: payloads a later posting decision reads off a SYNCED row are never compacted', async () => {
  // accounting-fx-revaluation reads prior UNREALISED_FX_JOURNAL payloads across PENDING/PROCESSING/
  // SYNCED to decide which to REVERSE before reposting; refund-service and the Group-B true-up sum
  // UNEARNED_REV_REVERSAL / COGS_REVERSAL `payload.lines` off the same statuses. Thinning one does not
  // lose an audit detail — it posts a duplicate journal.
  const result = await runAccountingCleanup([
    row({ id: 'fx', status: 'SYNCED', type: 'UNREALISED_FX_JOURNAL', resolvedAt: YEARS_AGO, payload: { kind: 'revaluation', lines: [{ accountCode: '860' }] } }),
    row({ id: 'unearned', status: 'SYNCED', type: 'UNEARNED_REV_REVERSAL', resolvedAt: YEARS_AGO, payload: { lines: [{ accountCode: '835', debit: 5 }] } }),
    row({ id: 'cogs', status: 'SYNCED', type: 'COGS_REVERSAL', resolvedAt: YEARS_AGO, payload: { _cogsReversalBase: 3.5 } }),
  ])

  assert.equal(result.accountingSyncLogsCompacted, 0)
  assert.deepEqual(accounting.updates, [])
  assert.deepEqual(accounting.rows.map((candidate) => candidate.payload !== null), [true, true, true])
})
