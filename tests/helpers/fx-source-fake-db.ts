/**
 * An in-memory stand-in for the parts of the database client the FX source code touches (fx_rates, currencies, settings, users) and for the exclusive FX table lock.
 * It records the ORDER of what happened (`events`) so a test can see that every fx_rates write happened inside the lock transaction, after the lock statement.
 */
export type FakeFxRateRow = {
  fromCurrency: string
  toCurrency: string
  rate: string
  fetchedAt: Date
  source: string
  manualOverride: boolean
}

export function createFxSourceFakeDb(seed: { currencies?: Array<{ code: string; active: boolean }>; rates?: FakeFxRateRow[]; settings?: Record<string, string> } = {}) {
  const rates: FakeFxRateRow[] = [...(seed.rates ?? [])]
  const currencies = [...(seed.currencies ?? [])]
  const settings = new Map<string, string>(Object.entries(seed.settings ?? {}))
  const events: string[] = []
  let inTx = false

  const matchRate = (row: FakeFxRateRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true
    for (const [key, cond] of Object.entries(where)) {
      const value = (row as Record<string, unknown>)[key]
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; not?: unknown }
        if (c.in && !c.in.includes(value)) return false
        if ('not' in c && value === c.not) return false
      } else if (cond instanceof Date) {
        if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false
      } else if (value !== cond) return false
    }
    return true
  }

  const fxRate = {
    findMany: async (args: { where?: Record<string, unknown>; orderBy?: unknown; distinct?: string[]; select?: unknown } = {}) => {
      events.push('fxRate.findMany')
      const matched = rates.filter((r) => matchRate(r, args.where)).sort((a, b) => a.toCurrency.localeCompare(b.toCurrency) || b.fetchedAt.getTime() - a.fetchedAt.getTime())
      if (!args.distinct) return matched
      const seen = new Set<string>()
      return matched.filter((r) => (seen.has(r.toCurrency) ? false : (seen.add(r.toCurrency), true)))
    },
    findFirst: async (args: { where?: Record<string, unknown> } = {}) => {
      events.push('fxRate.findFirst')
      return rates.find((r) => matchRate(r, args.where)) ?? null
    },
    create: async (args: { data: Record<string, unknown> }) => {
      events.push(inTx ? 'fxRate.create(in lock tx)' : 'fxRate.create(OUTSIDE lock tx)')
      const d = args.data
      const row: FakeFxRateRow = {
        fromCurrency: String(d.fromCurrency),
        toCurrency: String(d.toCurrency),
        rate: String(d.rate),
        fetchedAt: (d.fetchedAt as Date | undefined) ?? new Date(),
        source: String(d.source ?? 'frankfurter'),
        manualOverride: d.manualOverride === true,
      }
      rates.push(row)
      return row
    },
  }

  const setting = {
    findUnique: async (args: { where: { key: string } }) => (settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key) } : null),
    findMany: async (args: { where: { key: { in: string[] } } }) => args.where.key.in.filter((k) => settings.has(k)).map((key) => ({ key, value: settings.get(key) })),
    upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
      settings.set(args.where.key, settings.has(args.where.key) ? args.update.value : args.create.value)
      return {}
    },
  }

  const tx = {
    $executeRaw: async () => { events.push('lock'); return 1 },
    fxRate,
    setting,
  }

  const db = {
    currency: {
      findMany: async (args: { where?: { active?: boolean; code?: { not?: string } } } = {}) =>
        currencies.filter((c) => (args.where?.active === undefined || c.active === args.where.active) && (args.where?.code?.not === undefined || c.code !== args.where.code.not)),
    },
    fxRate,
    setting,
    user: { findMany: async () => [] },
    // The ECB path's "which currencies are pinned" read: the latest row per currency among the given codes.
    $queryRaw: async (_strings: unknown, codes: string[]) => {
      const latest = new Map<string, FakeFxRateRow>()
      for (const r of rates) {
        if (!codes.includes(r.toCurrency)) continue
        const cur = latest.get(r.toCurrency)
        if (!cur || r.fetchedAt.getTime() > cur.fetchedAt.getTime()) latest.set(r.toCurrency, r)
      }
      return [...latest.values()].map((r) => ({ toCurrency: r.toCurrency, manualOverride: r.manualOverride }))
    },
    $transaction: async <T,>(work: (t: typeof tx) => Promise<T>) => {
      events.push('tx.begin')
      inTx = true
      try { return await work(tx) } finally { inTx = false; events.push('tx.end') }
    },
  }

  return { db, rates, settings, events }
}

/** The shape Aelia's helper plugin answers with (see lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php), with the live facts known on 2026-10-26. */
export function aeliaAnswer(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    base: 'GBP',
    last_update: '2026-10-23T23:36:05Z',
    last_update_source: 'exchange_rates_last_update',
    rates: [
      { currency: 'EUR', rate: '1.194344', markup: '0.02', set_manually: false, decimals: 4 },
      { currency: 'USD', rate: '1.336829', markup: '0.02', set_manually: false },
      { currency: 'NOK', rate: '12.500597', markup: '0.02', set_manually: false },
    ],
    ...overrides,
  }
}
