/**
 * THE PURE HALF OF THE FX SOURCE SWITCH (no database): the setting keys, the parse, and the REGIME the exchange-rate lookup applies. lib/currencies/fx-source.ts adds the database reads.
 *
 * THE REGIME. `fx_rate_source` says which source feeds fx_rates; `fx_rate_source_since` is the INSTANT the source last changed, written in the same transaction (setFxRateSource, under the exclusive FX table
 * lock). While the source is 'aelia', a lookup dated AT OR AFTER that instant may only use source='aelia' rows and explicit manual overrides: an ECB row (older rows stay in the table; a newer one can
 * still arrive from a refresh that was in flight, and the barrier in fx-refresh.ts makes that impossible, but the lookup does not rely on it) is never eligible, and a currency Aelia has not given is
 * refused (reason no_rate_from_selected_source), never answered from an old ECB row. A lookup dated BEFORE the instant is unchanged, so every past document keeps its rate.
 *
 * WHY ONLY 'aelia' IS A REGIME. Under 'ecb' (the default and today's behaviour) the rule is the plain latest-row rule over every source: Aelia rows that exist are real rates that were valid, and a refusal
 * after switching BACK would stop documents in a currency the ECB fetch has not refreshed yet, to protect against nothing (no Aelia row can be stored after the switch back, so none can win wrongly). The
 * instant of a switch back is recorded all the same (fx_rate_source_since) and shown in the activity log.
 */
export const FX_RATE_SOURCE_SETTING = 'fx_rate_source'
export const FX_RATE_SOURCE_SINCE_SETTING = 'fx_rate_source_since'
export const FX_RATE_SOURCES = ['ecb', 'aelia'] as const
export type FxRateSource = (typeof FX_RATE_SOURCES)[number]

export function parseFxRateSource(value: string | null | undefined): FxRateSource {
  return value === 'aelia' ? 'aelia' : 'ecb'
}

/** The lookup's regime: null (no restriction) or the Aelia cutover. */
export type FxSourceRegime = { source: 'aelia'; since: Date } | null

/**
 * A source of 'aelia' with a missing or unreadable instant restricts EVERY lookup (since = the epoch) rather than quietly reverting to ECB: setFxRateSource always writes both together, so a half-written
 * pair is a fault, and the safe reading of a fault is the strict one.
 */
export function fxSourceRegimeFromSettings(source: string | null | undefined, since: string | null | undefined): FxSourceRegime {
  if (parseFxRateSource(source) !== 'aelia') return null
  const at = since ? new Date(since) : null
  return { source: 'aelia', since: at && Number.isFinite(at.getTime()) ? at : new Date(0) }
}

/** The one eligibility rule under the Aelia regime. */
export function eligibleUnderAeliaRegime(row: { source?: string; manualOverride?: boolean }): boolean {
  return row.source === 'aelia' || row.manualOverride === true
}

/** Read the regime through any client that can read settings (a Prisma client or transaction; the lookup passes its own, so one snapshot answers both). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural: a Prisma delegate's generic findMany is not assignable to a narrower signature
export async function getFxSourceRegime(client: { setting: { findMany: (args: any) => PromiseLike<Array<{ key: string; value: string }>> } }): Promise<FxSourceRegime> {
  const rows = await client.setting.findMany({ where: { key: { in: [FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING] } }, select: { key: true, value: true } })
  const get = (k: string) => rows.find((x) => x.key === k)?.value
  return fxSourceRegimeFromSettings(get(FX_RATE_SOURCE_SETTING), get(FX_RATE_SOURCE_SINCE_SETTING))
}
