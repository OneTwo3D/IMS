/**
 * An in-memory `fxRate` + `organisation` pair that answers exactly the queries lib/currencies/fx-lookup.ts
 * issues (`groupBy` for the latest fetchedAt per currency, `findMany` for the rows at that instant), so a caller
 * test can seed rates and watch a moved caller's behaviour. It is NOT proof of the SQL: tests/db/fx-lookup.test.ts
 * runs the same arms against Postgres.
 */
import type { FxLookupClient } from '@/lib/currencies/fx-lookup'

export type FakeFxRow = {
  fromCurrency: string
  toCurrency: string
  rate: unknown
  fetchedAt: Date
  source?: string
  manualOverride?: boolean
}

type Where = {
  fromCurrency?: string
  toCurrency?: string | { in: string[] }
  fetchedAt?: Date | { lte?: Date }
  OR?: Where[]
}

function matches(row: FakeFxRow, where: Where | undefined): boolean {
  if (!where) return true
  if (where.fromCurrency !== undefined && row.fromCurrency !== where.fromCurrency) return false
  if (typeof where.toCurrency === 'string' && row.toCurrency !== where.toCurrency) return false
  if (typeof where.toCurrency === 'object' && where.toCurrency && !where.toCurrency.in.includes(row.toCurrency)) return false
  if (where.fetchedAt instanceof Date && row.fetchedAt.getTime() !== where.fetchedAt.getTime()) return false
  if (where.fetchedAt && !(where.fetchedAt instanceof Date) && where.fetchedAt.lte && row.fetchedAt.getTime() > where.fetchedAt.lte.getTime()) return false
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false
  return true
}

export function fakeFxClient(rows: FakeFxRow[], baseCurrency: string | null = 'GBP'): FxLookupClient & { calls: Array<{ op: string; args: unknown }> } {
  const calls: Array<{ op: string; args: unknown }> = []
  const client = {
    calls,
    organisation: {
      findFirst: async (args: unknown) => {
        calls.push({ op: 'organisation.findFirst', args })
        return baseCurrency === null ? null : { baseCurrency }
      },
    },
    fxRate: {
      groupBy: async (args: { where?: Where; by: string[] }) => {
        calls.push({ op: 'fxRate.groupBy', args })
        const best = new Map<string, Date>()
        for (const r of rows.filter((x) => matches(x, args.where))) {
          const cur = best.get(r.toCurrency)
          if (!cur || r.fetchedAt.getTime() > cur.getTime()) best.set(r.toCurrency, r.fetchedAt)
        }
        return [...best.entries()].map(([toCurrency, fetchedAt]) => ({ toCurrency, _max: { fetchedAt } }))
      },
      findMany: async (args: { where?: Where }) => {
        calls.push({ op: 'fxRate.findMany', args })
        return rows
          .filter((x) => matches(x, args.where))
          .map((r) => ({ ...r, source: r.source ?? 'frankfurter', manualOverride: r.manualOverride ?? false }))
      },
    },
  }
  // The fake answers only the argument shapes fx-lookup.ts sends; Prisma's generic delegate signatures cannot be
  // satisfied structurally by a hand-written fake, so the cast is confined here.
  return client as unknown as FxLookupClient & { calls: typeof calls }
}
