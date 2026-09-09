import assert from 'node:assert/strict'

/**
 * A `shopping_sync_logs` delegate that ACTUALLY EVALUATES the `where` it is handed (o3d-272i).
 *
 * WHY THIS EXISTS. The order-delete guard's fixture used to be `parkedRefund: { id } | null`, served
 * by a `findFirst` that ignored its argument. Every assertion built on it was therefore a statement
 * about the fixture: the guard could have asked for anything at all — including the pre-`recordKind`
 * copy of the predicate that o3d-272i exists to remove — and the test would have passed unchanged.
 * A fake that answers without reading the question cannot fail for the reason the test names.
 *
 * ONE EVALUATOR, TWO READERS, for the same reason the predicate itself is now defined once: the
 * delete guard and the store-rebind guard must be tested against the SAME reading of a Prisma
 * `where`, or a divergence between them can hide in the test doubles.
 *
 * DELIBERATELY STRICT. An operator it does not implement THROWS rather than matching or skipping, so
 * a predicate that grows a new shape fails loudly here instead of being silently over- or
 * under-matched.
 */
export type WhereNode = Record<string, unknown>

export function matchesWhere(row: Record<string, unknown>, where: WhereNode): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = condition as WhereNode[]
      if (!branches.some((branch) => matchesWhere(row, branch))) return false
      continue
    }
    if (key === 'AND') {
      const branches = condition as WhereNode[]
      if (!branches.every((branch) => matchesWhere(row, branch))) return false
      continue
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object') {
      for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (operator === 'in') {
          if (!(operand as unknown[]).includes(value)) return false
        } else if (operator === 'startsWith') {
          if (typeof value !== 'string' || !value.startsWith(operand as string)) return false
        } else if (operator === 'not') {
          if (operand === null) {
            if (value === null || value === undefined) return false
          } else if (value === operand) {
            return false
          }
        } else {
          throw new Error(`unsupported operator in test evaluator: ${operator}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

export type ShoppingSyncLogRow = {
  id: string
  connector?: string
  direction?: string
  entityType?: string
  entityId?: string | null
  externalId?: string | null
  status?: string
  recordKind?: string | null
}

/** The column defaults a WooCommerce refund park is written with, so a fixture states only its point. */
export function shoppingSyncLogRows(rows: ShoppingSyncLogRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    entityId: 'order-1',
    externalId: null,
    status: 'PENDING',
    recordKind: 'WC_REFUND_PARK',
    ...row,
  }))
}

/**
 * The delegate. `findMany` honours `distinct`; `groupBy` counts by the requested columns. Both read
 * the `where`, which is the whole point.
 */
export function shoppingSyncLogFake(rows: ShoppingSyncLogRow[]) {
  const table = shoppingSyncLogRows(rows)
  const select = (where: WhereNode) => table.filter((row) => matchesWhere(row, where))
  return {
    findFirst: async ({ where }: { where: WhereNode }) => select(where)[0] ?? null,
    count: async ({ where }: { where: WhereNode }) => select(where).length,
    findMany: async ({ where, distinct }: { where: WhereNode; distinct?: string[] }) => {
      const hits = select(where)
      if (!distinct) return hits
      const seen = new Set<string>()
      return hits.filter((row) => {
        const key = JSON.stringify(distinct.map((column) => row[column]))
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
    groupBy: async ({ by, where }: { by: string[]; where: WhereNode }) => {
      assert.ok(by.length > 0, 'groupBy needs at least one column')
      const counts = new Map<string, { row: Record<string, unknown>; count: number }>()
      for (const row of select(where)) {
        const key = JSON.stringify(by.map((column) => row[column]))
        const current = counts.get(key)
        if (current) current.count += 1
        else counts.set(key, { row, count: 1 })
      }
      return [...counts.values()].map(({ row, count }) => ({
        ...Object.fromEntries(by.map((column) => [column, row[column]])),
        _count: { _all: count },
      }))
    },
  }
}
