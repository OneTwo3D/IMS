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

/**
 * The switch history is present but unreadable (reason fx_source_history_unreadable): every lookup refuses (fxSourceRegimeFromSettings) and every source switch is refused, so the earlier intervals are
 * never rewritten from a guess. REPAIR IS A MANUAL OPERATOR ACTION (no admin action exists for it): either write a valid JSON array of {"source":"ecb"|"aelia","since":"<ISO instant>"} entries, oldest
 * first, into the settings row `fx_rate_source_history`, or delete that row to accept "no recorded history" (the regime is then the current source and instant alone, and the next switch seeds the history
 * from them; earlier Aelia intervals are lost, so only do this when they are known to be none).
 */
export class FxSourceHistoryUnreadableError extends Error {
  readonly reason = 'fx_source_history_unreadable'
  constructor() {
    super('fx_source_history_unreadable: the stored FX source switch history is unreadable, so the source was not changed. Repair the settings row fx_rate_source_history (write a valid JSON array of {source, since} entries, oldest first, or delete the row if no Aelia period needs keeping), then try again.')
    this.name = 'FxSourceHistoryUnreadableError'
  }
}

/** One switch of the source: the new source and the instant (ISO) it took effect. */
export type FxSourceSwitch = { source: FxRateSource; since: string }
/** A span during which Aelia was the source: [since, until), `until` null while it still is. */
export type FxAeliaInterval = { since: Date; until: Date | null }
/** The lookup's regime: null (no Aelia interval ever) or the list of Aelia intervals. */
export type FxSourceRegime = { aelia: FxAeliaInterval[]; unreadable?: true } | null

const EPOCH_ISO = new Date(0).toISOString()

/** The recorded switches, oldest first; null when absent or unreadable. The CALLER tells them apart: an unreadable history that is present is a closed fault (fxSourceRegimeFromSettings), not an absence. */
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
  // A history that is PRESENT but unreadable is never rewritten: seeding from the current pair would silently drop the earlier Aelia intervals. Every switch is refused until an operator repairs it.
  if (existing === null && historyValue !== undefined && historyValue !== null) throw new FxSourceHistoryUnreadableError()
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
  // A history setting that is PRESENT but cannot be read is a fault, not an absence: the regime cannot be known, so every lookup refuses (fx_source_history_unreadable) whatever the current source.
  const parsedHistory = parseFxSourceHistory(history)
  if (history !== undefined && history !== null && parsedHistory === null) return { aelia: [], unreadable: true }
  const aelia: FxAeliaInterval[] = []
  let open: Date | null = null
  for (const entry of parsedHistory ?? []) {
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

/** The fields that order two rows of one pair: when it was stamped, then the order it was written in. */
export type FxOrderedRow = { fetchedAt: Date; source?: string; manualOverride?: boolean; seq?: bigint | number | null }

/**
 * Which of two rows is the later one: the later `fetchedAt`; on a tie the later write (higher `seq`). When either row has no `seq` a tie stays a tie (0), as it always was.
 */
export function compareFxRowOrder(a: FxOrderedRow, b: FxOrderedRow): number {
  const dt = a.fetchedAt.getTime() - b.fetchedAt.getTime()
  if (dt !== 0) return dt < 0 ? -1 : 1
  if (a.seq === undefined || a.seq === null || b.seq === undefined || b.seq === null) return 0
  const sa = BigInt(a.seq)
  const sb = BigInt(b.seq)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

/**
 * THE ONE ELIGIBILITY RULE under the Aelia regime, over the rows of ONE pair dated at or before the lookup's asOf. An Aelia row is eligible. A manual override is a PIN only while it is IN FORCE: the LATEST
 * row of that pair at asOf across ALL sources (later fetchedAt; on a tie the later write). A later row of any source, an ECB row included (clearing a pin inserts one), supersedes it, and a superseded pin is as ineligible as any other ECB row. The
 * lookup (fx-select.ts, fx-lookup.ts), the activation coverage check and the cutover's pin check all go through the lookup, so there is no second definition to drift.
 */
export function eligibleRowsUnderAeliaRegime<T extends FxOrderedRow>(inPair: readonly T[]): T[] {
  return inPair.filter((r) => r.source === 'aelia' || (r.manualOverride === true && !inPair.some((o) => compareFxRowOrder(o, r) > 0)))
}

/** Read the regime through any client that can read settings (a Prisma client or transaction; the lookup passes its own, so one snapshot answers both). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural: a Prisma delegate's generic findMany is not assignable to a narrower signature
export async function getFxSourceRegime(client: { setting: { findMany: (args: any) => PromiseLike<Array<{ key: string; value: string }>> } }): Promise<FxSourceRegime> {
  const rows = await client.setting.findMany({ where: { key: { in: [FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCE_HISTORY_SETTING] } }, select: { key: true, value: true } })
  const get = (k: string) => rows.find((x) => x.key === k)?.value
  return fxSourceRegimeFromSettings(get(FX_RATE_SOURCE_SETTING), get(FX_RATE_SOURCE_SINCE_SETTING), get(FX_RATE_SOURCE_HISTORY_SETTING))
}
