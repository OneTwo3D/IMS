/**
 * An in-memory stand-in for the `accountingSyncLog` Prisma delegate, faithful enough that a
 * compare-and-swap really succeeds or really fails.
 *
 * Written for o3d-e2mz: every test about the attempt fence turns on whether `updateMany` matched
 * ZERO rows or one. A stub that just returns a canned `{ count }` cannot show that — it would pass
 * with the fence removed, because the count never depended on the where clause. So this evaluates
 * the where against real rows.
 */

export type SyncLogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
  errorMessage: string | null
  retryCount: number
  attemptRevision: number
  processingStartedAt: Date | null
  syncedAt: Date | null
  createdAt: Date
}

export function syncLogRow(overrides: Partial<SyncLogRow> & { id: string }): SyncLogRow {
  return {
    connector: 'xero',
    type: 'COGS_JOURNAL',
    status: 'PENDING',
    referenceType: 'CogsEntry',
    referenceId: 'ref-1',
    externalTransactionId: null,
    payload: {},
    errorMessage: null,
    retryCount: 0,
    attemptRevision: 0,
    processingStartedAt: null,
    syncedAt: null,
    createdAt: new Date('2026-08-19T09:00:00.000Z'),
    ...overrides,
  }
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime()
  if (typeof condition === 'object') {
    const spec = condition as Record<string, unknown>
    for (const [operator, operand] of Object.entries(spec)) {
      switch (operator) {
        case 'equals': if (!matchesCondition(value, operand)) return false; break
        case 'not': if (matchesCondition(value, operand)) return false; break
        case 'in': if (!(operand as unknown[]).some((candidate) => matchesCondition(value, candidate))) return false; break
        case 'notIn': if ((operand as unknown[]).some((candidate) => matchesCondition(value, candidate))) return false; break
        case 'lt': if (!(compare(value, operand) < 0)) return false; break
        case 'lte': if (!(compare(value, operand) <= 0)) return false; break
        case 'gt': if (!(compare(value, operand) > 0)) return false; break
        case 'gte': if (!(compare(value, operand) >= 0)) return false; break
        default: throw new Error(`accounting-sync-log-store: unsupported filter operator ${operator}`)
      }
    }
    return true
  }
  return value === condition
}

function compare(value: unknown, other: unknown): number {
  const left = value instanceof Date ? value.getTime() : (value as number)
  const right = other instanceof Date ? other.getTime() : (other as number)
  if (left === null || left === undefined) return Number.NaN
  return left < right ? -1 : left > right ? 1 : 0
}

export function matchesWhere(row: SyncLogRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (key === 'AND') {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matchesWhere(row, clause))) return false
      continue
    }
    if (key === 'NOT') {
      if (matchesWhere(row, condition as Record<string, unknown>)) return false
      continue
    }
    if (!matchesCondition((row as unknown as Record<string, unknown>)[key], condition)) return false
  }
  return true
}

/**
 * Apply an update `data` the way Prisma does — including the atomic number operations, so a fence that
 * advances a revision with `{ increment: 1 }` really moves the row. Assigning the operation object
 * verbatim (the naive stub) would leave `attemptRevision` holding `{ increment: 1 }`, and every
 * subsequent CAS on a number would then fail for the wrong reason.
 */
function applyData(row: SyncLogRow, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      const spec = value as Record<string, unknown>
      const current = (row as unknown as Record<string, unknown>)[key]
      if ('increment' in spec) {
        ;(row as unknown as Record<string, unknown>)[key] = (current as number) + (spec.increment as number)
        continue
      }
      if ('decrement' in spec) {
        ;(row as unknown as Record<string, unknown>)[key] = (current as number) - (spec.decrement as number)
        continue
      }
      if ('set' in spec) {
        ;(row as unknown as Record<string, unknown>)[key] = spec.set
        continue
      }
      throw new Error(`accounting-sync-log-store: unsupported update operation on ${key}`)
    }
    ;(row as unknown as Record<string, unknown>)[key] = value
  }
}

export type SyncLogStore = {
  rows: SyncLogRow[]
  /** Every `where` an updateMany was attempted with, in order — so a missing fence is visible. */
  updateManyWheres: Array<Record<string, unknown>>
  delegate: Record<string, (args: never) => Promise<unknown>>
  get(id: string): SyncLogRow | undefined
}

export function createSyncLogStore(initial: SyncLogRow[] = []): SyncLogStore {
  const rows = [...initial]
  const updateManyWheres: Array<Record<string, unknown>> = []

  const delegate = {
    findMany: async ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {}) => {
      let found = rows.filter((row) => matchesWhere(row, where))
      const [field, direction] = Object.entries(orderBy ?? {})[0] ?? []
      if (field) {
        found = [...found].sort((a, b) => {
          const delta = compare((a as unknown as Record<string, unknown>)[field], (b as unknown as Record<string, unknown>)[field])
          return direction === 'desc' ? -delta : delta
        })
      }
      return (take ? found.slice(0, take) : found).map((row) => ({ ...row }))
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = rows.find((candidate) => candidate.id === where.id)
      return row ? { ...row } : null
    },
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const row = rows.find((candidate) => matchesWhere(candidate, where))
      return row ? { ...row } : null
    },
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows.filter((row) => matchesWhere(row, where)).length,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      updateManyWheres.push(where)
      let count = 0
      for (const row of rows) {
        if (!matchesWhere(row, where)) continue
        applyData(row, data)
        count += 1
      }
      return { count }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id)
      if (!row) throw new Error(`accounting-sync-log-store: no row ${where.id}`)
      applyData(row, data)
      return { ...row }
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = syncLogRow({ id: `log-${rows.length + 1}`, ...(data as Partial<SyncLogRow>) } as Partial<SyncLogRow> & { id: string })
      rows.push(row)
      return { ...row }
    },
  }

  return {
    rows,
    updateManyWheres,
    delegate: delegate as unknown as SyncLogStore['delegate'],
    get: (id: string) => rows.find((row) => row.id === id),
  }
}
