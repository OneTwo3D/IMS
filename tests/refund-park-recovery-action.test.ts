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
  /** Whether the fake store sends `x-wp-totalpages` at all. See the wcFetch double. */
  reportTotalPages: true,
  /**
   * The page size this store actually SERVES, whatever is asked for. WooCommerce's own ceiling is a
   * hundred, and that is the default here — but a store may cap lower (a hosting filter on
   * `woocommerce_rest_orders_per_page`, a security plugin, a proxy) and it does NOT error when asked
   * for more: it quietly serves its own size. A double that always served what it was asked for
   * could not tell a capped page from a complete collection, which is the blind spot under test.
   */
  wcServerPageCap: 100,
  /**
   * A page the store served SHORT for this request alone: page number -> how many rows came back.
   *
   * A GRANTED SIZE IS NOT A PROMISE, and this is the double that says so. `wcServerPageCap` models a
   * store that consistently serves a smaller page; this models one that does not serve the SAME size
   * twice — a proxy that trims one response, a security plugin shedding load, a host lowering a
   * filter between two calls. The offset is unaffected (WooCommerce still pages by `per_page`), so
   * the rows in the gap are simply never served: page two comes back with forty rows out of a
   * hundred, and rows 140-199 are not in any response at all.
   *
   * Without this, a double could not falsify "a page shorter than one this same store filled proves
   * the end" — every page it served would be the same size, and the rule would look sound.
   */
  wcTrimmedPages: new Map<number, number>(),
  /**
   * Runs after each refund request is served, with the page that was served — the seam that lets a
   * test MOVE THE STORE UNDER THE WALK, which is the only way finding 1 can be falsified at all.
   *
   * It hands the test the live array, so both directions are modelled honestly and neither is
   * simulated: `splice` DELETES a refund (rows after it shift DOWN an offset, and a row can be
   * skipped between two pages), `unshift` CREATES one at the front the way WooCommerce's newest-first
   * ordering does (rows shift UP, and one gets served twice), and `push` appends without moving
   * anything. The pager is real, so what those do to the pages is whatever WooCommerce's own offset
   * arithmetic does to them — a double that produced the SYMPTOM directly would be agreeing with the
   * fix rather than testing it.
   */
  wcAfterRequest: null as ((page: number) => void) | null,
  /** Refund ids the store returns with an unusable `id`, e.g. a string where a number belongs. */
  wcUnreadableIds: new Set<number>(),
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
    /**
     * WooCommerce's REAL collection semantics, not a convenient approximation:
     *
     *  - `per_page` DEFAULTS TO TEN and CAPS AT ONE HUNDRED, so code that asks for neither gets ten
     *    and code that asks for more than a hundred still gets a hundred. A double that served
     *    whatever was asked for would let a one-page read pass as exhaustive, and the pre-fix code
     *    would agree with it — a double written to agree with the code cannot falsify it.
     *  - AND THE CEILING IS THE STORE'S TO CHOOSE (`state.wcServerPageCap`). A store that caps below
     *    a hundred answers a request for a hundred with its own size and no error at all, so every
     *    page it serves is "shorter than we asked for". Code that reads that as an ending reads the
     *    FIRST page of such a store as the whole collection.
     *  - `x-wp-totalpages` is a HEADER, and `wcFetch` reads a missing header as `parseInt('1')`. So a
     *    store that does not report a total is INDISTINGUISHABLE, at this seam, from one reporting a
     *    single page. `reportTotalPages: false` reproduces that exactly, by answering 1 — not 0, not
     *    undefined — because 1 is what production would actually see.
     */
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      state.wcCalls.push({ path, params })
      if (state.wcError) return { data: null, totalPages: 0, totalItems: 0, error: state.wcError }
      const match = /^\/orders\/(\d+)\/refunds$/.exec(path)
      if (!match) throw new Error(`test double does not implement WC path ${path}`)
      if (state.wcCalls.length > 40) throw new Error(`the refund read did not terminate: ${state.wcCalls.length} requests`)
      const all = state.wcRefundsByOrder.get(Number(match[1])) ?? []
      const requested = Number(params.per_page ?? '10')
      const perPage = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10, state.wcServerPageCap)
      const page = Number(params.page ?? '1')
      const totalPages = state.reportTotalPages ? Math.max(1, Math.ceil(all.length / perPage)) : 1
      const slice = all.slice((page - 1) * perPage, page * perPage)
      // Trimmed AFTER the slice, so the offset stays where WooCommerce would put it and the missing
      // rows are lost rather than shifted onto the next page — which is what actually happens when
      // something between the store and us shortens a response.
      const trimTo = state.wcTrimmedPages.get(page)
      const body = typeof trimTo === 'number' ? slice.slice(0, trimTo) : slice
      state.wcAfterRequest?.(page)
      return {
        data: body.map((id) => (state.wcUnreadableIds.has(id) ? { id: String(id) } : { id })),
        totalPages,
        // A store that sends no page-count header sends no item-count header either, and `wcFetch`
        // reads a missing `x-wp-total` as 0. Modelled exactly, so a test that means "this store
        // reports nothing" does not quietly get the count guard for free.
        totalItems: state.reportTotalPages ? all.length : 0,
      }
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
  state.reportTotalPages = true
  state.wcServerPageCap = 100
  state.wcTrimmedPages = new Map()
  state.wcAfterRequest = null
  state.wcUnreadableIds = new Set()
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

// ---------------------------------------------------------------------------
// A SERVER-SIDE CAP MUST NOT TURN PAGE ONE INTO PROOF (Codex round 2, finding 1)
// ---------------------------------------------------------------------------

test('a store that caps per_page below what we ask for cannot end the walk on its first page', async () => {
  // THE BLIND SPOT. `per_page` is a REQUEST. A store capping at ten answers our hundred with ten and
  // no error, so EVERY page it serves is "shorter than we asked for" — and a walk that ends on that
  // comparison ends on page one, always, having read a tenth of the collection. Its output then says
  // "WooCommerce does not list refund 7001 on this order", which is the whole of what authorises a
  // DISMISSAL: the park is written off over money that has already left the business, on a list that
  // never contained the page the refund was on.
  //
  // Twenty-five refunds behind a ten-row cap, with 7001 the twenty-first — page THREE. Paired with a
  // store that sends no page-count header, which is the arrangement round 1 already established is
  // indistinguishable from "one page".
  const recover = await loadAction()
  state.wcServerPageCap = 10
  state.reportTotalPages = false
  const held = Array.from({ length: 25 }, (_, i) => 8000 + i)
  held[20] = 7001
  state.wcRefundsByOrder.set(2002, held)
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success?: boolean }).success, false)
  // WooCommerce does list the refund on this order, so the dismissal is contradicted rather than
  // granted — the opposite verdict to the one a page-one read produces.
  assert.equal((result as { code?: string }).code, 'wc_confirms_current_owner')
  assert.equal(stored().status, 'FAILED', 'the park survives')
  // FOUR requests for three pages of content: the twenty-five rows end on a short page, and a short
  // page ends nothing. Only the empty fourth one does. TWICE, because this is the dismissal path and
  // the two walks have to agree before an absence may be acted on.
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '3', '4', '1', '2', '3', '4'])
  assert.equal(state.wcCalls[0].params.per_page, '100', 'we still ASK for the maximum — we just do not believe it')
})

test('a page that is full for the store and short for the request still only ends on the EMPTY page', async () => {
  // Ten refunds behind a ten-row cap: a FULL page for this store, a short one for the request. Under
  // either reading the walk must go on and find page two empty before it can call the list complete —
  // the request's size was never evidence, and after round 4 the store's own size is not either.
  const recover = await loadAction()
  state.wcServerPageCap = 10
  state.reportTotalPages = false
  state.wcRefundsByOrder.set(2002, Array.from({ length: 10 }, (_, i) => 8000 + i))
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success: boolean }).success, true, 'a genuinely complete list still resolves')
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '1', '2'])
})

test('an EMPTY page ends the walk whatever size the store is serving', async () => {
  // The rule that makes a capped store terminable at all: with the granted size unknown on page one,
  // the only unconditional proof of an ending is a page lying past the end of the collection. Four
  // refunds behind a ten-row cap — page one is short by BOTH readings, and page two settles it.
  const recover = await loadAction()
  state.wcServerPageCap = 10
  state.reportTotalPages = false
  state.wcRefundsByOrder.set(2002, [9001, 9002, 9003, 9004])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success: boolean }).success, true)
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '1', '2'])
  assert.match(stored().errorMessage ?? '', /did NOT list refund 7001/)
})

// ---------------------------------------------------------------------------
// A CAP THAT VARIES BETWEEN REQUESTS (Codex round 3, finding 1)
// ---------------------------------------------------------------------------

test('a page the store TRIMS mid-walk cannot end the walk — a granted size is not a promise', async () => {
  // THE DEFECT ROUND 3 LEFT BEHIND. Round 3 stopped measuring pages against what we ASKED for and
  // started measuring them against the first page the store FILLED. That survives a store with a
  // lower fixed cap — and nothing else. `per_page` is a request and the answer is whatever arrives:
  // a proxy trims one response, a security plugin sheds load, a host lowers a filter between two
  // calls. Page one comes back with a hundred and page two with forty, and "shorter than a page this
  // same store filled" reads the forty as the end of the collection.
  //
  // 250 refunds, page two trimmed to forty, and the parked refund 7001 is the 206th — page THREE,
  // PAST the trimmed page and therefore genuinely reachable. A walk that stops on page two never
  // sees it, reports it absent, and DISMISSES the park: money that has already left the business,
  // written off on a list that stopped two pages early. Paired with a store that reports no counts at
  // all, so nothing but the pages themselves can catch it.
  const recover = await loadAction()
  state.reportTotalPages = false
  state.wcTrimmedPages = new Map([[2, 40]])
  const held = Array.from({ length: 250 }, (_, i) => 8000 + i)
  held[205] = 7001
  state.wcRefundsByOrder.set(2002, held)
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success?: boolean }).success, false)
  // WooCommerce does list the refund on this order, so the dismissal is CONTRADICTED — the opposite
  // verdict to the one a walk that ended on the trimmed page produces.
  assert.equal((result as { code?: string }).code, 'wc_confirms_current_owner')
  assert.equal(stored().status, 'FAILED', 'the park survives')
  // Four requests for three pages of content, and the fourth is the only proof of an ending there is.
  // Both walks trim the same way — a store that lies identically twice is not a collection that moved,
  // and the second read is not claimed to catch it (the count guard and this refusal do).
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '3', '4', '1', '2', '3', '4'])
})

test('a store that serves FEWER refunds than it says the order has refuses, whatever the pages looked like', async () => {
  // THE HALF NO RULE ABOUT PAGE LENGTHS CAN REACH. Here the trimmed page is not the last one: rows
  // 140-199 are never served by any request, the walk ends cleanly on a later EMPTY page, and the
  // list it returns is quietly missing sixty refunds — including 7001, which sits in the gap. Every
  // rule about lengths is satisfied; the answer is still wrong, and it authorises a dismissal.
  //
  // What catches it is the count the store itself stated. `x-wp-total` cannot END a walk (a store
  // that omits it arrives as 0, and a header cannot prove a body), but banking fewer rows than the
  // store says exist is proof of the opposite, and it is free.
  const recover = await loadAction()
  state.wcTrimmedPages = new Map([[2, 40]])
  const held = Array.from({ length: 250 }, (_, i) => 8000 + i)
  held[150] = 7001
  state.wcRefundsByOrder.set(2002, held)
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_lookup_failed')
  assert.match((result as { error: string }).error, /has 250 refunds but served only 190 of them/)
  assert.equal(stored().status, 'FAILED', 'the park survives')
  assert.equal(state.transactions, 0, 'and nothing is opened, let alone written')
})

test('a refund created DURING the walk does not turn a complete read into a refusal', async () => {
  // The count guard must not fire on the ordinary race. A refund added between two requests raises
  // the total the LATER pages report, and a list one row short of the newest claim is not evidence
  // that anything was trimmed — so the SMALLEST total stated anywhere in the walk is the one used.
  // Taking the latest instead would refuse every order that gains a refund while it is being read.
  //
  // 150 refunds over two full-ish pages, and the 151st arrives after the second page has been
  // served: the empty third page then reports 151 against the 150 rows actually banked. Asserted on
  // the REASSIGN path, which reads once — the dismissal path's second read is a different rule with
  // a different answer (below), and this one is about the total, not about the second read.
  const recover = await loadAction()
  const many = Array.from({ length: 150 }, (_, i) => 8000 + i)
  many[149] = 7001
  state.wcRefundsByOrder.set(1001, many)
  state.wcAfterRequest = (page) => {
    if (page === 2) state.wcRefundsByOrder.get(1001)!.push(9999)
  }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.deepEqual(result, { success: true, outcome: 'REASSIGN', targetOrderId: 'order-A' }, 'a complete read still resolves')
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '3'])
})

// ---------------------------------------------------------------------------
// OFFSET PAGING OVER A LIVE COLLECTION IS NOT A SNAPSHOT (Codex round 4, finding 1)
//
// Every rule above is about the PAGES. None of them is about the collection the pages are cut out
// of, and WooCommerce cuts them BY POSITION: "rows 100 to 199 of whatever is there when you ask".
// So the collection moving under the walk is a separate hazard from anything a page can reveal.
// ---------------------------------------------------------------------------

test('a refund DELETED behind the cursor hides a row that no page and no count can catch', async () => {
  // THE DEFECT ROUND 4 LEFT BEHIND, and the one that dismisses a live park.
  //
  // 101 refunds, and the parked refund 7001 is the LAST of them. Page one serves rows 0-99. Then a
  // refund that has ALREADY BEEN READ is deleted in WooCommerce — a hundred rows remain, so page two
  // (offsets 100+) comes back EMPTY, and 7001, which slid from offset 100 to offset 99, is served to
  // nobody at all.
  //
  // Every guard on this path is satisfied, and that is the point of the numbers chosen:
  //   • the walk ended on an EMPTY page — the only unconditional proof of an ending there is;
  //   • no page was short of anything, so no length rule has anything to say;
  //   • and the STATED-TOTAL GUARD BALANCES EXACTLY. The store has a hundred refunds by the time it
  //     is asked how many, and exactly a hundred rows were banked — because the list still carries
  //     the id of the refund that was DELETED. It is one id too long by precisely the amount it is
  //     one id too short, so the arithmetic agrees with itself while the answer is wrong.
  //
  // So the read reports "WooCommerce does not list refund 7001 on this order", which is the whole of
  // what authorises writing the refund off. What catches it is the SECOND read: the deleted refund
  // cannot be served again, so the two answers cannot agree.
  const recover = await loadAction()
  const held = Array.from({ length: 101 }, (_, i) => 8000 + i)
  held[100] = 7001
  state.wcRefundsByOrder.set(2002, held)
  let deleted = false
  state.wcAfterRequest = (page) => {
    if (page !== 1 || deleted) return
    deleted = true
    // Behind the cursor: a row page one has already served. That is the direction that LOSES a row.
    state.wcRefundsByOrder.get(2002)!.splice(5, 1)
  }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_refund_list_unstable')
  assert.match((result as { error: string }).error, /the first read listed refund 8005 and the second did not/)
  assert.match((result as { error: string }).error, /the second read listed refund 7001 and the first did not/)
  // And the message says WHY a client cannot do better, so the operator is not sent hunting for a fault.
  assert.match((result as { error: string }).error, /one page at a time BY POSITION/)
  assert.equal(stored().status, 'FAILED', 'the park survives')
  assert.equal(stored().entityId, 'order-B')
  assert.equal(state.transactions, 0, 'and nothing is opened, let alone written')
})

test('the same refund served twice is proof the list moved, and the read refuses on the spot', async () => {
  // The other direction, and the one a single walk CAN see. WooCommerce lists refunds newest first,
  // so a refund CREATED mid-walk takes offset 0 and pushes everything down — page two then re-serves
  // the row that ended page one. Nothing is lost that way, but the trace is not spent: a collection
  // that can shift down can shift up, and the shift up is invisible.
  //
  // On the REASSIGN path deliberately, which reads ONCE: this guard lives in the walk itself, not in
  // the dismissal's second read, and reassign is the path that would otherwise have succeeded here.
  const recover = await loadAction()
  const many = Array.from({ length: 150 }, (_, i) => 8000 + i)
  many[149] = 7001
  state.wcRefundsByOrder.set(1001, many)
  let created = false
  state.wcAfterRequest = (page) => {
    if (page !== 1 || created) return
    created = true
    state.wcRefundsByOrder.get(1001)!.unshift(9999)
  }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.equal((result as { code?: string }).code, 'wc_refund_list_unstable')
  assert.match((result as { error: string }).error, /served refund 8099 twice, on different pages/)
  assert.equal(stored().entityId, 'order-B', 'the park does not move')
  assert.equal(stored().status, 'FAILED')
  assert.equal(state.transactions, 0)
})

test('a refund created on the parked order between the two reads stops the dismissal', async () => {
  // The ordinary version of the same hazard, and the reason the second read is worth its requests
  // even when nothing was lost: this order is BEING REFUNDED while an operator is deciding whether
  // to write a refund off it. The first read is complete and the second is complete, and they are
  // answers about two different collections — so the absence the first one established is not a fact
  // about the store as it now is.
  const recover = await loadAction()
  state.wcRefundsByOrder.set(2002, Array.from({ length: 4 }, (_, i) => 8000 + i))
  let created = false
  state.wcAfterRequest = (page) => {
    // BETWEEN the two reads, not inside either: the first walk is complete and honest, and so is the
    // second. Neither the empty-page rule nor the count guard has anything to object to.
    if (page !== 2 || created) return
    created = true
    state.wcRefundsByOrder.get(2002)!.unshift(9999)
  }
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_refund_list_unstable')
  assert.match((result as { error: string }).error, /the second read listed refund 9999 and the first did not/)
  assert.match((result as { error: string }).error, /try this recovery again in a moment/)
  assert.equal(stored().status, 'FAILED', 'the park survives')
  assert.equal(state.transactions, 0)
})

// ---------------------------------------------------------------------------
// WHAT THE OPERATOR IS ASKED FOR MUST BE WHAT THE SERVER CONSUMES
// ---------------------------------------------------------------------------

test('the recovery panel asks for the WooCommerce order ID, which is what the server sends', async () => {
  // The value typed into that field is sent to WooCommerce verbatim as /orders/{value}/refunds,
  // which addresses an order by its ID. The field used to be labelled "order number". On a plain
  // store the two are equal, so the wrong label is invisible and reads as correct — but with a
  // sequential-order-number plugin they diverge, and an operator doing exactly what the label says
  // then supplies a value that resolves to SOMEBODY ELSE'S order or to none. Reassigning a refund
  // onto the wrong order is the very fault this panel exists to repair.
  //
  // Asserted against the source rather than a rendered tree: what is being pinned is a WORD in a
  // label, and a DOM harness for this panel would test the harness. The pairing that matters — that
  // the same value reaches wcFetch as a path segment — is covered by the action tests above.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const panel = readFileSync(join(process.cwd(), 'app/(dashboard)/sync/exceptions/exceptions-client.tsx'), 'utf8')

  assert.match(panel, /WooCommerce order ID that holds this refund/, 'the field asks for the ID')
  assert.doesNotMatch(
    panel,
    /WooCommerce order number that holds this refund/,
    'and never for the order number, which is a different value wherever numbering is customised',
  )
  // The operator has to be able to FIND the id, so saying "ID" is not on its own enough.
  assert.match(panel, /not the order number the customer sees/)
  assert.match(panel, /parent_id/, 'and the refund itself names its parent order')

  // The server consumes it as a path segment against WooCommerce — the fact the label has to match.
  const action = readFileSync(join(process.cwd(), 'app/actions/sync-exceptions.ts'), 'utf8')
  assert.match(action, /`\/orders\/\$\{wcOrderId\}\/refunds`/)
})

// ---------------------------------------------------------------------------
// THE EVIDENCE MUST BE KNOWN COMPLETE — an ambiguous answer refuses, it does not resolve
// ---------------------------------------------------------------------------

test('a store that reports no page total cannot dismiss a refund sitting on page two', async () => {
  // THE HARM, in the one arrangement that produces it. `wcFetch` parses `x-wp-totalpages` as
  // parseInt(header ?? '1'), so a store sending no header arrives as totalPages: 1 — identical, at
  // this seam, to a store that genuinely has one page. Ending the walk there takes "the store said
  // nothing" for "the store said there is no more".
  //
  // 150 refunds on the parked order, and the parked refund 7001 is the 120th of them — page TWO. A
  // walk that stops on the silent header reports it ABSENT, and absent from this order is precisely
  // what authorises a dismissal. The park would be written off, on a list that never contained the
  // page the refund was on, over money that has already left the business.
  const recover = await loadAction()
  state.reportTotalPages = false
  const held = Array.from({ length: 150 }, (_, i) => 8000 + i)
  held[119] = 7001
  state.wcRefundsByOrder.set(2002, held)
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success?: boolean }).success, false)
  // WooCommerce still confirms this order owns the refund, so the dismissal is contradicted.
  assert.equal((result as { code?: string }).code, 'wc_confirms_current_owner')
  assert.equal(stored().status, 'FAILED', 'the park survives')
  assert.equal(stored().entityId, 'order-B')
  // 150 refunds at a hundred a page: pages one and two hold them all, and page three proves it —
  // and the dismissal path reads the lot twice.
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '3', '1', '2', '3'])
})

test('a FULL page always advances, so completeness comes from the body and not from a header', async () => {
  // The mechanism behind the test above, asserted directly: a page holding exactly what was asked
  // for is never the proof of an ending, whatever the header claims. The second request is the
  // whole fix — without it the walk ends on the header and the answer above flips to a dismissal.
  const recover = await loadAction()
  state.reportTotalPages = false
  state.wcRefundsByOrder.set(1001, [...Array.from({ length: 100 }, (_, i) => 8000 + i), 7001])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'REASSIGN', wcOrderId: 1001 })
  assert.deepEqual(result, { success: true, outcome: 'REASSIGN', targetOrderId: 'order-A' })
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '2', '3'])
})

test('an order with more refunds than the check will read REFUSES rather than answering short', async () => {
  // Every page the walk is willing to read came back full, so there may well be another. A list not
  // known to be complete cannot be used to prove a refund missing — and this is a REFUSAL, not a
  // truncated success, because the caller one frame up cannot tell a partial list from a whole one.
  const recover = await loadAction()
  state.reportTotalPages = false
  state.wcRefundsByOrder.set(2002, Array.from({ length: 1500 }, (_, i) => 8000 + i))
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_lookup_failed')
  assert.match((result as { error: string }).error, /more than this check will read/)
  assert.equal(stored().status, 'FAILED')
  assert.equal(state.transactions, 0, 'and nothing is opened, let alone written')
})

test('a store REPORTING an oversized total is refused on the first request, not after ten', async () => {
  // The header is still worth reading for the one thing it can do — fail fast and cheaply — and the
  // refusal must come before the page is banked, or an oversized order costs ten round trips to the
  // live store for an answer already known to be unusable.
  const recover = await loadAction()
  state.wcRefundsByOrder.set(2002, Array.from({ length: 1500 }, (_, i) => 8000 + i))
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_lookup_failed')
  assert.match((result as { error: string }).error, /15 pages of refunds/)
  assert.equal(state.wcCalls.length, 1, 'one request, then the refusal')
})

test('a refund WooCommerce lists with an unreadable id refuses — a list we cannot read proves nothing', async () => {
  // The same error in miniature, and it used to be a silent `continue`: an entry whose id is not a
  // usable integer was dropped, and the resulting list was then used to establish that some OTHER
  // refund is not in it. A list with a row we cannot read cannot establish that.
  const recover = await loadAction()
  state.wcRefundsByOrder.set(2002, [9001, 9002])
  state.wcUnreadableIds = new Set([9002])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { code?: string }).code, 'wc_lookup_failed')
  assert.match((result as { error: string }).error, /no readable id/)
  assert.equal(stored().status, 'FAILED')
})

test('an order with no refunds at all is still a COMPLETE answer, and dismisses', async () => {
  // The bound must not swallow the ordinary case it exists to protect. An empty page is the
  // shortest page there is, so absence really is established, and the dismissal proceeds.
  const recover = await loadAction()
  state.reportTotalPages = false
  state.wcRefundsByOrder.set(2002, [])
  const result = await recover('log-1', { observedOrderId: 'order-B', outcome: 'DISMISS' })
  assert.equal((result as { success: boolean }).success, true)
  // Two requests, not one: the whole walk again, and both answers agreeing that there is nothing
  // there. That is the cost of a dismissal, and it is the cheapest order there is.
  assert.deepEqual(state.wcCalls.map((call) => call.params.page), ['1', '1'])
  assert.equal(state.activity[0]?.metadata && (state.activity[0].metadata as { wcEvidenceReads?: number }).wcEvidenceReads, 2)
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
