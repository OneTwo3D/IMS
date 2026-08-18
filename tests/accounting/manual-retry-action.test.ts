import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-0m56 — BEHAVIOURAL coverage of the two manual retry actions.
 *
 * `manual-retry-guard.test.ts` pins the pure planner and then asserts the ACTIONS' wiring by
 * reading their source. Source assertions catch a deleted call; they cannot catch a wiring bug
 * that keeps every string in place — a sibling query that returns the wrong rows, a scope key
 * that groups two references together, an `allowedIds` computed from the wrong set. So this
 * drives both actions end to end against a database double and asserts what actually happens to
 * the rows.
 *
 * It is also the issue's own stated test contract: "two FAILED INVOICE_PAYMENT rows for one
 * order, same accountingInvoiceId; assert the per-row retry action refuses."
 *
 * THE DOUBLE IS STRICT ON PURPOSE. Every filter key the actions use is implemented, and an
 * unrecognised one THROWS rather than being ignored. A double that quietly drops a `where`
 * clause it does not understand returns too many rows and turns a broken guard green — the
 * failure mode this file exists to rule out.
 */

type Row = {
  id: string
  connector: string
  type: string
  referenceType: string
  referenceId: string
  status: string
  payload: Record<string, unknown> | null
}

const state = {
  rows: [] as Row[],
  activities: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
}

const SELECTABLE = new Set(['id', 'type', 'referenceType', 'referenceId', 'payload', 'status', 'connector'])

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const arms = value as Array<Record<string, unknown>>
      if (!arms.some((arm) => matches(row, arm))) return false
      continue
    }
    if (key === 'id' && typeof value === 'object' && value !== null && 'in' in value) {
      if (!(value as { in: string[] }).in.includes(row.id)) return false
      continue
    }
    if (!SELECTABLE.has(key)) {
      // Never silently ignored: an unimplemented filter would widen the result set and could
      // make a broken guard look correct.
      throw new Error(`the accountingSyncLog double does not implement the filter "${key}"`)
    }
    if (typeof value !== 'string') throw new Error(`unsupported filter shape for "${key}": ${JSON.stringify(value)}`)
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false
  }
  return true
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'user-1' }),
    requireFreshPermission: async () => ({ id: 'user-1' }),
    requireRole: async () => ({ id: 'user-1' }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { state.activities.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
          state.rows
            .filter((row) => matches(row, where))
            .map((row) => Object.fromEntries(
              Object.keys(select).map((field) => [field, (row as unknown as Record<string, unknown>)[field]]),
            )),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = state.rows.filter((row) => matches(row, where))
          for (const row of hit) if (typeof data.status === 'string') row.status = data.status
          return { count: hit.length }
        },
      },
    },
  },
})

const payload = (accountingInvoiceId: string, extra: Record<string, unknown> = {}) =>
  ({ accountingInvoiceId, bankAccountId: 'bank-1', amount: 10, ...extra })

function seed(connector: string) {
  state.rows = [
    // AMBIGUOUS: two failed payments for one order against the SAME invoice, neither carrying a
    // token, so each derives its own row id. Either may have committed.
    { id: 'a1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', status: 'FAILED', payload: payload('inv-1') },
    { id: 'a2', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-1', status: 'FAILED', payload: payload('inv-1') },
    // SAFE: a lone failed payment — retrying re-posts under its own unchanged token.
    { id: 'b1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-2', status: 'FAILED', payload: payload('inv-2') },
    // SAFE: not money-moving. A duplicate PDF is not a financial error.
    { id: 'c1', connector, type: 'INVOICE_PDF', referenceType: 'SalesOrder', referenceId: 'so-3', status: 'FAILED', payload: payload('inv-3') },
    { id: 'c2', connector, type: 'INVOICE_PDF', referenceType: 'SalesOrder', referenceId: 'so-3', status: 'FAILED', payload: payload('inv-3') },
    // AMBIGUOUS via a NON-FAILED sibling: the SYNCED row demonstrably reached the ledger under a
    // different token, so re-posting the failed one lands a second payment beside it. A sibling
    // snapshot restricted to FAILED would never see this.
    { id: 'd1', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-4', status: 'FAILED', payload: payload('inv-4') },
    { id: 'd2', connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-4', status: 'SYNCED', payload: payload('inv-4') },
    // Another connector's ambiguous scope — must be invisible to this action entirely.
    { id: 'x1', connector: 'other', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-9', status: 'FAILED', payload: payload('inv-9') },
    { id: 'x2', connector: 'other', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'so-9', status: 'FAILED', payload: payload('inv-9') },
  ]
  state.activities = []
}

const statusOf = (id: string) => state.rows.find((row) => row.id === id)?.status

const ACTIONS = [
  { connector: 'xero', module: '@/app/actions/xero-sync', fn: 'retryFailedXeroSync', refusalAction: 'xero_manual_retry_refused' },
  { connector: 'quickbooks', module: '@/app/actions/quickbooks-sync', fn: 'retryFailedQuickBooksSync', refusalAction: 'quickbooks_manual_retry_refused' },
] as const

for (const action of ACTIONS) {
  async function load(): Promise<(entryId?: string) => Promise<{ success: boolean; reset: number; refused?: number; error?: string }>> {
    const mod = await import(action.module) as Record<string, unknown>
    return mod[action.fn] as never
  }

  test(`${action.connector}: the per-row retry REFUSES an ambiguous scope and leaves the row FAILED (o3d-0m56)`, async () => {
    seed(action.connector)
    const retry = await load()

    const result = await retry('a1')

    assert.equal(result.success, false, 'the operator must be told, not silently given a no-op')
    assert.equal(result.reset, 0)
    assert.match(String(result.error), /could post a second payment/)
    assert.match(String(result.error), /SalesOrder so-1/, 'the refusal must name the reference')
    assert.equal(statusOf('a1'), 'FAILED', 'the row must NOT be re-queued')
    assert.equal(statusOf('a2'), 'FAILED', 'and neither must its sibling')

    const refusal = state.activities.filter((entry) => entry.action === action.refusalAction)
    assert.equal(refusal.length, 1, 'the refusal must be recorded exactly once')
    assert.deepEqual(refusal[0]?.metadata?.syncLogIds, ['a1'], 'only the row the operator clicked')
  })

  test(`${action.connector}: the per-row retry ALLOWS a lone failed payment (o3d-0m56)`, async () => {
    // The narrowness that matters: the id filter hides the siblings, so a guard that judged on
    // row count would refuse every single-row retry there is.
    seed(action.connector)
    const retry = await load()

    const result = await retry('b1')

    assert.equal(result.success, true)
    assert.equal(result.reset, 1)
    assert.equal(result.refused, undefined)
    assert.equal(statusOf('b1'), 'PENDING')
  })

  test(`${action.connector}: "Retry All" re-queues the safe scopes and refuses only the ambiguous ones (o3d-0m56)`, async () => {
    // The worst version of the bug: one click re-queued EVERY ambiguous scope at once, each row
    // under its own distinct token. It must now split the batch rather than passing or failing
    // it whole.
    seed(action.connector)
    const retry = await load()

    const result = await retry()

    assert.equal(result.success, true)
    assert.equal(result.reset, 3, 'b1 and both PDF rows')
    assert.equal(result.refused, 3, 'a1, a2 and d1')

    assert.equal(statusOf('a1'), 'FAILED')
    assert.equal(statusOf('a2'), 'FAILED')
    assert.equal(statusOf('d1'), 'FAILED', 'a SYNCED sibling under another token is money already posted')
    assert.equal(statusOf('b1'), 'PENDING')
    assert.equal(statusOf('c1'), 'PENDING')
    assert.equal(statusOf('c2'), 'PENDING')

    assert.equal(statusOf('d2'), 'SYNCED', 'the reset must never touch a non-FAILED row')
    assert.equal(statusOf('x1'), 'FAILED', 'another connector\'s rows are out of scope entirely')

    const refusals = state.activities.filter((entry) => entry.action === action.refusalAction)
    assert.equal(refusals.length, 2, 'one warning per refused SCOPE, not one per refused row')
    assert.deepEqual(
      refusals.map((entry) => entry.metadata?.syncLogIds).sort(),
      [['a1', 'a2'], ['d1']].sort(),
    )
  })
}

test('quickbooks: rows sharing the generic idempotency key are NOT ambiguous (o3d-0m56)', async () => {
  // QuickBooks honours `_idempotencyKey`, so two rows carrying the same one post under the same
  // Request-Id and Intuit deduplicates. Deriving the token from the row id instead — as Xero's
  // payment branches do — would refuse this safe retry. The action must apply its OWN
  // connector's derivation, not a shared one.
  seed('quickbooks')
  state.rows = state.rows.map((row) => (
    row.id === 'a1' || row.id === 'a2'
      ? { ...row, payload: payload('inv-1', { _idempotencyKey: 'invoice-payment:payment:p1' }) }
      : row
  ))
  const { retryFailedQuickBooksSync } = await import('@/app/actions/quickbooks-sync')

  const result = await retryFailedQuickBooksSync('a1')

  assert.equal(result.success, true, 'a shared token is the ordinary QuickBooks shape')
  assert.equal(statusOf('a1'), 'PENDING')

  // ...and the same payload on Xero, whose payment branches ignore the generic key, stays
  // ambiguous — two row ids, two tokens.
  seed('xero')
  state.rows = state.rows.map((row) => (
    row.id === 'a1' || row.id === 'a2'
      ? { ...row, payload: payload('inv-1', { _idempotencyKey: 'invoice-payment:payment:p1' }) }
      : row
  ))
  const { retryFailedXeroSync } = await import('@/app/actions/xero-sync')
  assert.equal((await retryFailedXeroSync('a1')).success, false, 'Xero never sent that key')
  assert.equal(statusOf('a1'), 'FAILED')
})
