import { Prisma } from '@/app/generated/prisma/client'

/**
 * An in-memory stand-in for the three tables and the few other delegates the custom-field services touch, so the rules are tested
 * without a database. Row-level behaviour that only a real database can prove (the unique indexes, the CHECK constraints, the foreign
 * keys) is proven in tests/db/custom-fields.test.ts.
 */
export type FakeDefinition = {
  id: string; entity: 'PRODUCT' | 'SALES_ORDER'; namespace: string; key: string; label: string; type: string
  options: unknown; required: boolean; sortOrder: number; active: boolean
}
export type FakeValue = {
  id: string; definitionId: string; productId: string | null; salesOrderId: string | null
  valueText: string | null; valueDecimal: string | null; valueBoolean: boolean | null; valueDate: Date | null; valueDateTime: Date | null; valueJson: unknown
}

export type FakeState = {
  definitions: FakeDefinition[]
  values: FakeValue[]
  products: Array<{ id: string; sku: string }>
  orders: Array<{ id: string; orderNumber: string | null; externalOrderNumber: string | null; erasedAt: Date | null }>
  activity: Array<Record<string, unknown>>
  locks: string[]
  writes: string[]
  nextId: number
  /** Raise a unique-violation on the next definition create. */
  uniqueViolationOnCreate: boolean
}

export function freshState(): FakeState {
  return { definitions: [], values: [], products: [], orders: [], activity: [], locks: [], writes: [], nextId: 1, uniqueViolationOnCreate: false }
}

export function def(partial: Partial<FakeDefinition> & Pick<FakeDefinition, 'id' | 'type'>): FakeDefinition {
  return { entity: 'PRODUCT', namespace: 'logistics', key: partial.id, label: `Label ${partial.id}`, options: null, required: false, sortOrder: 0, active: true, ...partial }
}

const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
  if (!where) return true
  return Object.entries(where).every(([key, cond]) => {
    const actual = row[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('in' in c) return (c.in as unknown[]).includes(actual)
      if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual)
      if ('not' in c) return actual !== c.not
    }
    return actual === cond
  })
}

export function makeTx(state: FakeState, prismaError: new (message: string, init: { code: string; clientVersion: string }) => Error) {
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const first = args[0] as { sql?: string; strings?: string[]; values?: unknown[] } | TemplateStringsArray
      const text = Array.isArray(first) ? (first as string[]).join('?') : ((first as { strings?: string[] }).strings ?? []).join('?')
      state.locks.push(text.replace(/\s+/g, ' ').trim())
      return []
    },
    customFieldDefinition: {
      count: async (args: { where?: Record<string, unknown> }) => state.definitions.filter((d) => matches(d, args.where)).length,
      findMany: async (args: { where?: Record<string, unknown> }) => state.definitions.filter((d) => matches(d, args.where)).map((d) => ({ ...d })),
      findUnique: async (args: { where: { id: string } }) => {
        const found = state.definitions.find((d) => d.id === args.where.id)
        return found ? { ...found } : null
      },
      create: async (args: { data: Omit<FakeDefinition, 'id'> & { options?: unknown } }) => {
        if (state.uniqueViolationOnCreate || state.definitions.some((d) => d.entity === args.data.entity && d.key === args.data.key)) {
          throw new prismaError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
        }
        const row: FakeDefinition = { ...args.data, id: `def${state.nextId++}`, options: isDbNull(args.data.options) ? null : args.data.options, active: true }
        state.definitions.push(row)
        state.writes.push('definition.create')
        return { ...row }
      },
      update: async (args: { where: { id: string }; data: Partial<FakeDefinition> }) => {
        const row = state.definitions.find((d) => d.id === args.where.id)!
        Object.assign(row, { ...args.data, options: 'options' in args.data ? (isDbNull(args.data.options) ? null : args.data.options) : row.options })
        state.writes.push('definition.update')
        return { ...row }
      },
      delete: async (args: { where: { id: string } }) => {
        state.definitions = state.definitions.filter((d) => d.id !== args.where.id)
        state.writes.push('definition.delete')
        return {}
      },
    },
    customFieldValue: {
      count: async (args: { where?: Record<string, unknown> }) => state.values.filter((v) => matches(v, args.where)).length,
      findMany: async (args: { where?: Record<string, unknown>; distinct?: string[]; take?: number }) => {
        let rows = state.values.filter((v) => matches(v, args.where)).map((v) => ({ ...v }))
        if (args.distinct?.includes('valueText')) rows = rows.filter((r, i) => rows.findIndex((x) => x.valueText === r.valueText) === i)
        return args.take ? rows.slice(0, args.take) : rows
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        const before = state.values.length
        state.values = state.values.filter((v) => !matches(v, args.where))
        state.writes.push('value.deleteMany')
        return { count: before - state.values.length }
      },
      upsert: async (args: { where: Record<string, { definitionId: string; productId?: string; salesOrderId?: string }>; create: Partial<FakeValue>; update: Partial<FakeValue> }) => {
        const key = Object.values(args.where)[0]!
        const existing = state.values.find((v) => v.definitionId === key.definitionId && v.productId === (key.productId ?? null) && v.salesOrderId === (key.salesOrderId ?? null))
        const clean = (data: Partial<FakeValue>) => ({ ...data, valueJson: isDbNull(data.valueJson) ? null : data.valueJson })
        if (existing) Object.assign(existing, clean(args.update))
        else {
          const created: FakeValue = { id: `val${state.nextId++}`, definitionId: key.definitionId, productId: null, salesOrderId: null, valueText: null, valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null }
          Object.assign(created, clean(args.create))
          state.values.push(created)
        }
        state.writes.push('value.upsert')
        return {}
      },
    },
    salesOrder: { findUnique: async (args: { where: { id: string } }) => state.orders.find((o) => o.id === args.where.id) ?? null },
    product: { findUnique: async (args: { where: { id: string } }) => state.products.find((p) => p.id === args.where.id) ?? null },
    activityLog: { create: async (args: { data: Record<string, unknown> }) => { state.activity.push(args.data); return {} } },
  }
  return tx
}

function isDbNull(value: unknown): boolean {
  return value === Prisma.DbNull
}
