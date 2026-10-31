/**
 * THE PURE HALF OF THE FX SOURCE SWITCH (no database): the setting keys, the parse, and the REGIME the exchange-rate lookup applies. lib/currencies/fx-source.ts adds the database reads.
 *
 * THE REGIME. `fx_rate_source` says which source feeds fx_rates; `fx_rate_source_since` is the INSTANT the source last changed, written in the same transaction (setFxRateSource, under the exclusive FX table
 * lock). While a lookup's `asOf` falls inside an AELIA INTERVAL, it may only use source='aelia' rows and explicit manual overrides: an ECB row (older rows stay in the table; a newer one can still arrive from a
 * refresh that was in flight, and the barrier in fx-refresh.ts makes that impossible, but the lookup does not rely on it) is never eligible, and a currency Aelia has not given is refused (reason
 * no_rate_from_selected_source), never answered from an old ECB row. A lookup dated before every Aelia interval is unchanged, so every past document keeps its rate.
 *
 * THE SWITCH HISTORY. Each switch appends one entry {source, since} to `fx_rate_source_history`, in the same transaction as the switch. An Aelia interval runs from an 'aelia' entry to the next 'ecb' entry
 * (open-ended while Aelia is current). The lookup selects the regime IN EFFECT AT ITS asOf, so after a switch back to ECB a document dated in the Aelia period still uses Aelia rows and cannot pick up a
 * later ECB row. With no history (a database from before it, or one that never switched) the regime is the current pair alone, exactly as before. The current pair is always honoured as well: if the two
 * ever disagree the stricter reading wins.
 */
export const FX_RATE_SOURCE_SETTING = 'fx_rate_source'
export const FX_RATE_SOURCE_SINCE_SETTING = 'fx_rate_source_since'
export const FX_RATE_SOURCES = ['ecb', 'aelia'] as const
export type FxRateSource = (typeof FX_RATE_SOURCES)[number]

export function parseFxRateSource(value: string | null | undefined): FxRateSource {
  return value === 'aelia' ? 'aelia' : 'ecb'
}

export const FX_RATE_SOURCE_HISTORY_SETTING = 'fx_rate_source_history'

/** One switch of the source: the new source and the instant (ISO) it took effect. */
export type FxSourceSwitch = { source: FxRateSource; since: string }
/** A span during which Aelia was the source: [since, until), `until` null while it still is. */
export type FxAeliaInterval = { since: Date; until: Date | null }
/** The lookup's regime: null (no Aelia interval ever) or the list of Aelia intervals. */
export type FxSourceRegime = { aelia: FxAeliaInterval[] } | null

const EPOCH_ISO = new Date(0).toISOString()

/** The recorded switches, oldest first; null when absent or unreadable (an unreadable history is not trusted, the current pair still applies). */
export function parseFxSourceHistory(value: string | null | undefined): FxSourceSwitch[] | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: FxSourceSwitch[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return null
    const { source, since } = entry as { source?: unknown; since?: unknown }
    if (source !== 'ecb' && source !== 'aelia') return null
    if (typeof since !== 'string' || !Number.isFinite(new Date(since).getTime())) return null
    out.push({ source, since })
  }
  return out.sort((x, y) => new Date(x.since).getTime() - new Date(y.since).getTime())
}

/**
 * The history string to store when the source switches to `source` at `at`. A database from before the history seeds it from the current pair (an Aelia source with its instant), so the interval that
 * was already running is not lost by the first switch back.
 */
export function appendFxSourceSwitch(
  historyValue: string | null | undefined,
  currentSource: string | null | undefined,
  currentSince: string | null | undefined,
  source: FxRateSource,
  at: Date,
): string {
  const existing = parseFxSourceHistory(historyValue)
  const seeded: FxSourceSwitch[] = existing ?? (parseFxRateSource(currentSource) === 'aelia'
    ? [{ source: 'aelia', since: currentSince && Number.isFinite(new Date(currentSince).getTime()) ? new Date(currentSince).toISOString() : EPOCH_ISO }]
    : [])
  return JSON.stringify([...seeded, { source, since: at.toISOString() }])
}

/**
 * The regime from the stored settings. A source of 'aelia' with a missing or unreadable instant restricts EVERY lookup (since = the epoch) rather than quietly reverting to ECB: setFxRateSource always writes
 * the pair together, so a half-written pair is a fault, and the safe reading of a fault is the strict one.
 */
export function fxSourceRegimeFromSettings(source: string | null | undefined, since: string | null | undefined, history?: string | null): FxSourceRegime {
  const aelia: FxAeliaInterval[] = []
  let open: Date | null = null
  for (const entry of parseFxSourceHistory(history) ?? []) {
    const at = new Date(entry.since)
    if (entry.source === 'aelia') {
      if (!open) open = at
    } else if (open) {
      aelia.push({ since: open, until: at })
      open = null
    }
  }
  if (open) aelia.push({ since: open, until: null })
  if (parseFxRateSource(source) === 'aelia') {
    const at = since ? new Date(since) : null
    const start = at && Number.isFinite(at.getTime()) ? at : new Date(0)
    if (!aelia.some((i) => i.until === null && i.since.getTime() === start.getTime())) aelia.push({ since: start, until: null })
  }
  return aelia.length ? { aelia } : null
}

/** True when `asOf` falls inside an Aelia interval: only Aelia rows and manual overrides may answer it. */
export function fxRegimeRestrictsAt(regime: FxSourceRegime, asOf: Date): boolean {
  if (!regime) return false
  const t = asOf.getTime()
  return regime.aelia.some((i) => t >= i.since.getTime() && (i.until === null || t < i.until.getTime()))
}

/** The one eligibility rule under the Aelia regime. */
export function eligibleUnderAeliaRegime(row: { source?: string; manualOverride?: boolean }): boolean {
  return row.source === 'aelia' || row.manualOverride === true
}

/** Read the regime through any client that can read settings (a Prisma client or transaction; the lookup passes its own, so one snapshot answers both). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural: a Prisma delegate's generic findMany is not assignable to a narrower signature
export async function getFxSourceRegime(client: { setting: { findMany: (args: any) => PromiseLike<Array<{ key: string; value: string }>> } }): Promise<FxSourceRegime> {
  const rows = await client.setting.findMany({ where: { key: { in: [FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCE_HISTORY_SETTING] } }, select: { key: true, value: true } })
  const get = (k: string) => rows.find((x) => x.key === k)?.value
  return fxSourceRegimeFromSettings(get(FX_RATE_SOURCE_SETTING), get(FX_RATE_SOURCE_SINCE_SETTING), get(FX_RATE_SOURCE_HISTORY_SETTING))
}
