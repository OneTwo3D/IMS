import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

// o3d-54p — recoverRefundSyncPark: its guard, the FRESH WooCommerce verification it will not act
// without, the per-refund advisory lock it shares with createSalesOrderRefund and upsertRefundPark,
// the fence that stops a conclusion about the park as shown landing on the park as it became, and
// what each outcome writes.
//
// Every refusal is asserted on its SPECIFIC code. "It did not work" and "WooCommerce says this
// refund really does belong here" are completely different facts for an operator standing in front
// of a refund whose money has already left the business.

class ForbiddenError extends Error {}
class FreshAuthRequiredError extends Error {
  readonly code = 'fresh_auth_required'
  readonly reason = 'stale'
}

type ParkRow = {
  id: string
  connector: string
  direction: string
  entityType: string
  status: string
  entityId: string | null
  externalId: string | null
  errorMessage: string | null
  payload: unknown
  syncedAt: Date | null
  createdAt: Date
}

const state = {
  permissions: new Set<string>(['sync']),
  freshAuthFails: false,
  parks: [] as ParkRow[],
  refunds: [] as Array<{ externalRefundId: number; orderId: string }>,
  links: [] as Array<{ orderId: string; connector: string; externalOrderId: string }>,
  orders: new Set<string>(),
  activity: [] as Array<Record<string, unknown>>,
  rawSql: [] as string[],
  /** WooCommerce's answer per order id. Absent => an error from the store. */
  wcRefundsByOrder: new Map<number, number[]>(),
  wcError: null as string | null,
  wcCalls: [] as Array<{ path: string; params: Record<string, string> }>,
  /** Runs once, inside the transaction, after the advisory lock — to move the world under the write. */
  mutateUnderLock: null as (() => void) | null,
  transactions: 0,
}

// --- an honest Prisma double ------------------------------------------------------------------
// Only the operators these paths use. Anything else throws rather than silently matching, because a
// matcher that ignores a `where` clause turns a test into a tautology — and REFUND_PARK_WHERE's
// payload/OR/NOT predicate is exactly the kind that gets ignored by accident.

function jsonPath(value: unknown, path: string[]): unknown {
  let cursor = value
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch))) return false
      continue
    }
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
      continue
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object') {
      const test = condition as Record<string, unknown>
      for (const op of Object.keys(test)) {
        if (op === 'in') {
          if (!(test.in as unknown[]).includes(value)) return false
        } else if (op === 'not') {
          if (test.not === null ? value === null : value === test.not) return false
        } else if (op === 'equals') {
          if (test.equals === Prisma.DbNull) {
            if (value !== null && value !== undefined) return false
          } else if (test.path) {
            if (jsonPath(value, test.path as string[]) !== test.equals) return false
          } else if (value !== test.equals) {
            return false
          }
        } else if (op === 'path') {
          // handled together with `equals` above
          if (!('equals' in test)) throw new Error('test double: path without equals')
        } else {
          throw new Error(`test double does not implement where operator ${op}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}

function recordRaw(strings: TemplateStringsArray, values: unknown[]) {
  state.rawSql.push(strings.join('?') + ' :: ' + JSON.stringify(values))
}

function makeClient() {
  return {
    shoppingSyncLog: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = state.parks.find((p) => matches(p as unknown as Record<string, unknown>, where))
        return row ? project(row as unknown as Record<string, unknown>, select) : null
      },
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        state.parks
          .filter((p) => matches(p as unknown as Record<string, unknown>, where))
          .map((p) => project(p as unknown as Record<string, unknown>, select)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = state.parks.filter((p) => matches(p as unknown as Record<string, unknown>, where))
        for (const hit of hits) Object.assign(hit, data)
        return { count: hits.length }
      },
    },
    salesOrderRefund: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = state.refunds.find((r) => matches(r as unknown as Record<string, unknown>, where))
        return row ? project(row as unknown as Record<string, unknown>, select) : null
      },
    },
    shoppingOrderLink: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = state.links.find((l) => matches(l as unknown as Record<string, unknown>, where))
        return row ? project(row as unknown as Record<string, unknown>, select) : null
      },
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recordRaw(strings, values)
      // The advisory lock is the point at which the world stops moving; anything the test wants to
      // race against this write has to happen exactly here.
      if (state.mutateUnderLock) {
        const mutate = state.mutateUnderLock
        state.mutateUnderLock = null
        mutate()
      }
      return 1
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recordRaw(strings, values)
      const sql = strings.join('')
      if (/FROM "sales_orders"/.test(sql)) {
        const id = values[0] as string
        return state.orders.has(id) ? [{ id }] : []
      }
      throw new Error(`test double does not implement raw query: ${sql}`)
    },
  }
}

const client = makeClient()

mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      if (state.freshAuthFails) throw new FreshAuthRequiredError('Re-authentication required')
      return { user: { id: 'op-1' } }
    },
    requirePermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
    freshAuthFailureResult: (error: unknown) =>
      error instanceof FreshAuthRequiredError
        ? { success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale' }
        : null,
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      // ROLLBACK IS REAL. A double whose $transaction just runs the callback cannot tell "nothing was
      // written" from "everything was written and then reported as a failure" — the single most
      // important property of a recovery that can move refund evidence between orders.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        state.transactions += 1
        const snapshot = state.parks.map((p) => ({ ...p }))
        try {
          return await fn(client)
        } catch (error) {
          state.parks = snapshot
          throw error
        }
      },
    },
  },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      state.wcCalls.push({ path, params })
      if (state.wcError) return { data: null, totalPages: 0, totalItems: 0, error: state.wcError }
      const match = /^\/orders\/(\d+)\/refunds$/.exec(path)
      if (!match) throw new Error(`test double does not implement WC path ${path}`)
      const all = state.wcRefundsByOrder.get(Number(match[1])) ?? []
      const perPage = Number(params.per_page ?? '10')
      const page = Number(params.page ?? '1')
      const totalPages = Math.max(1, Math.ceil(all.length / perPage))
      const slice = all.slice((page - 1) * perPage, page * perPage)
      return { data: slice.map((id) => ({ id })), totalPages, totalItems: all.length }
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function loadAction() {
  return (await import('@/app/actions/sync-exceptions')).recoverRefundSyncPark
}

function parkRow(over: Partial<ParkRow> = {}): ParkRow {
  return {
    id: 'log-1',
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    status: 'FAILED',
    entityId: 'order-B',
    externalId: '7001',
    errorMessage: 'WooCommerce refund 7001 amount mismatch',
    payload: null,
    syncedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...over,
  }
}

function stored(id = 'log-1') {
  const row = state.parks.find((p) => p.id === id)
  assert.ok(row, `park ${id} should still exist`)
  return row
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.freshAuthFails = false
  state.parks = [parkRow()]
  state.refunds = []
  // order-B is the park's (wrong) order, WC #2002; order-A is the true owner, WC #1001.
  state.links = [
    { orderId: 'order-B', connector: 'woocommerce', externalOrderId: '2002' },
    { orderId: 'order-A', connector: 'woocommerce', externalOrderId: '1001' },
  ]
  state.orders = new Set(['order-A', 'order-B'])
  state.activity = []
  state.rawSql = []
  state.wcRefundsByOrder = new Map([[1001, [7001]], [2002, [9001]]])
  state.wcError = null
  state.wcCalls = []
  state.mutateUnderLock = null
  state.transactions = 0
})

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('the recovery needs the sync permission, which READONLY and SUPPLIER do not hold', async () => {
  const recover = await loadAction()
  state.permissions = new Set()
  await assert.rejects(
    () => recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 }),
    (error: unknown) => error instanceof ForbiddenError,
  )
  assert.equal(state.wcCalls.length, 0, 'a refused caller must not reach WooCommerce')
  assert.equal(stored().entityId, 'order-B')
})

test('a stale session is reported as a fresh-auth failure, not as a recovery refusal', async () => {
  const recover = await loadAction()
  state.freshAuthFails = true
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.deepEqual(result, { success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale' })
  assert.equal(stored().entityId, 'order-B')
})

// ---------------------------------------------------------------------------
// REASSIGN — the way out of the park Retry can never resolve
// ---------------------------------------------------------------------------

test('a verified reassign moves the park to its true owner and makes it retryable there', async () => {
  const recover = await loadAction()
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.deepEqual(result, { success: true, outcome: 'REASSIGN', targetOrderId: 'order-A' })

  const row = stored()
  assert.equal(row.entityId, 'order-A', 'the park now sits on the order WooCommerce named')
  assert.equal(row.status, 'PENDING', 'and PENDING is the one actionable status the sweep dedup does not skip')
  assert.match(row.errorMessage ?? '', /Recovered by operator: reassigned/)
  assert.match(row.errorMessage ?? '', /WooCommerce confirmed refund 7001 on order 1001/)
  // The park id is unchanged: one row that MOVED, not one that vanished and another that appeared —
  // which is also why the partial unique index on (connector, externalId) is never re-entered.
  assert.equal(row.id, 'log-1')
})

test('the reassign is serialized on the SAME per-refund key the refund create and park create take', async () => {
  const recover = await loadAction()
  await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  const lock = state.rawSql.find((sql) => sql.includes('pg_advisory_xact_lock'))
  assert.ok(lock, 'without the advisory lock a refund create on the true owner races this write')
  assert.match(lock, /hashtext/)
  assert.ok(lock.includes('"wc_refund:7001"'), `the key must be the o3d-ee9 one, got ${lock}`)
  // And the target order is row-locked before a park is written onto it, exactly as upsertRefundPark
  // does, so a concurrent deleteSalesOrder cannot leave an orphaned park on a gone order.
  const forUpdate = state.rawSql.find((sql) => sql.includes('FROM "sales_orders"'))
  assert.ok(forUpdate, 'the target order must be locked and re-verified before the park lands on it')
  assert.ok(forUpdate.includes('order-A'))
  // Ordering matters: advisory lock FIRST, then the row lock, matching the other two writers.
  assert.ok(
    state.rawSql.findIndex((s) => s.includes('pg_advisory_xact_lock'))
      < state.rawSql.findIndex((s) => s.includes('FROM "sales_orders"')),
    'advisory lock must be taken before the order row lock or the three writers can deadlock',
  )
})

test('a refund on the SECOND page of WooCommerce refunds is still found', async () => {
  // WooCommerce pages /orders/{id}/refunds at 10 by default and syncRefundsForOrder never asks for
  // more. Reading one page here would make a refund on page 2 look ABSENT — and "absent from this
  // order" is precisely what authorises a dismissal. This is the case that would silently dismiss a
  // real park.
  const recover = await loadAction()
  const many = Array.from({ length: 150 }, (_, i) => 8000 + i)
  many[149] = 7001
  state.wcRefundsByOrder.set(1001, many)
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.deepEqual(result, { success: true, outcome: 'REASSIGN', targetOrderId: 'order-A' })
  assert.ok(state.wcCalls.length >= 2, 'the second page must actually be requested')
  assert.equal(state.wcCalls[0].params.per_page, '100')
})

test('a reassign to an order WooCommerce says has no such refund is refused, and writes nothing', async () => {
  const recover = await loadAction()
  state.wcRefundsByOrder.set(1001, [7002])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'refund_not_in_asserted_order')
  assert.equal(stored().entityId, 'order-B')
  assert.equal(stored().status, 'FAILED')
  assert.equal(state.transactions, 0, 'a refusal on evidence must not open a transaction at all')
})

test('a WooCommerce lookup failure refuses by that name and never falls back to the parked payload', async () => {
  const recover = await loadAction()
  state.wcError = 'HTTP 503'
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'wc_lookup_failed')
  assert.match((result as { error: string }).error, /HTTP 503/)
  assert.equal(stored().entityId, 'order-B')
})

// ---------------------------------------------------------------------------
// DISMISS — verified against the parked order's OWN refunds
// ---------------------------------------------------------------------------

test('a verified dismissal resolves the park without moving it or claiming the refund applied', async () => {
  const recover = await loadAction()
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS', reason: 'deleted in WC' })
  assert.deepEqual(result, { success: true, outcome: 'DISMISS', targetOrderId: null })

  const row = stored()
  assert.equal(row.status, 'SYNCED', 'SYNCED is this table\'s operator-resolved terminal (see data-retention.ts)')
  assert.equal(row.entityId, 'order-B', 'the false association stays readable on the row')
  // And SYNCED does not become a claim the refund posted: a real landing CLEARS errorMessage, a
  // dismissal replaces it.
  assert.match(row.errorMessage ?? '', /Recovered by operator: dismissed/)
  assert.match(row.errorMessage ?? '', /did NOT list refund 7001/)
  assert.match(row.errorMessage ?? '', /deleted in WC/)
})

test('a dismissal WooCommerce contradicts is refused as "this park is not stale"', async () => {
  const recover = await loadAction()
  state.wcRefundsByOrder.set(2002, [7001])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_confirms_current_owner')
  assert.equal(stored().status, 'FAILED')
})

test('a dismissal on an order with no WooCommerce link cannot be verified, so it is refused', async () => {
  const recover = await loadAction()
  state.links = state.links.filter((l) => l.orderId !== 'order-B')
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'parked_order_not_linked')
  assert.equal(state.wcCalls.length, 0)
  assert.equal(stored().status, 'FAILED')
})

// ---------------------------------------------------------------------------
// The fence — a conclusion about the park as SHOWN must not land on the park as it BECAME
// ---------------------------------------------------------------------------

test('a park that has moved off the order the operator judged refuses before WooCommerce is asked', async () => {
  const recover = await loadAction()
  state.parks[0].entityId = 'order-C'
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'park_moved')
  assert.equal(state.wcCalls.length, 0)
  assert.equal(stored().entityId, 'order-C')
})

test('a park resolved under the lock is refused rather than re-opened', async () => {
  const recover = await loadAction()
  state.mutateUnderLock = () => { state.parks[0].status = 'SYNCED'; state.parks[0].errorMessage = null }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'park_moved')
  assert.equal(stored().status, 'SYNCED')
  assert.equal(stored().entityId, 'order-B', 'a recorded resolution is never rewritten by a recovery')
})

test('a refund that lands on the park\'s own order under the lock makes it a leftover, not a foreign park', async () => {
  const recover = await loadAction()
  state.mutateUnderLock = () => { state.refunds.push({ externalRefundId: 7001, orderId: 'order-B' }) }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'refund_already_landed')
  assert.equal(stored().entityId, 'order-B')
  assert.equal(stored().status, 'FAILED', 'nothing was written — the whole transaction is refused')
})

test('a target order deleted under the lock refuses rather than orphaning a park on a gone order', async () => {
  const recover = await loadAction()
  state.mutateUnderLock = () => { state.orders.delete('order-A') }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'target_order_missing')
  assert.equal(stored().entityId, 'order-B')
})

test('an already-resolved park is refused with the reason, not silently re-recovered', async () => {
  const recover = await loadAction()
  state.parks[0].status = 'SYNCED'
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'park_not_actionable')
  assert.equal(state.wcCalls.length, 0)
})

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

test('the recovery records the evidence it was made on, not just that it happened', async () => {
  const recover = await loadAction()
  await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  const entry = state.activity.find((a) => a.action === 'wc_refund_park_recovered')
  assert.ok(entry, 'a human moving refund evidence between orders must be on the record')
  assert.equal(entry.level, 'WARNING')
  const metadata = entry.metadata as Record<string, unknown>
  assert.equal(metadata.outcome, 'REASSIGN')
  assert.equal(metadata.parkedOrderId, 'order-B')
  assert.equal(metadata.targetOrderId, 'order-A')
  assert.equal(metadata.priorStatus, 'FAILED')
  assert.equal(metadata.userId, 'op-1')
  // The WooCommerce answer itself, so the recovery can be re-judged later against the evidence it
  // was actually made on rather than against WooCommerce as it is by then.
  assert.deepEqual(metadata.wcRefundIds, [7001])
  assert.equal(metadata.wcOrderId, 1001)
  assert.ok(typeof metadata.wcFetchedAt === 'string')
})
