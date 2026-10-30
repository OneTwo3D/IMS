/**
 * Bounds and helpers of the cutover to the Aelia FX source (setFxRateSource in app/actions/currencies.ts): the read of the store happens while the EXCLUSIVE FX table lock is held, so it is bounded.
 * (Kept out of the 'use server' file, which may export only async functions.)
 */
/** The cutover read is abandoned after this (a hard race around the transport's own 15 s timeout). */
export const AELIA_CUTOVER_READ_BOUND_MS = 20_000
/** The whole cutover transaction (and so the exclusive lock) is rolled back after this. */
export const AELIA_CUTOVER_TX_TIMEOUT_MS = 45_000

export class FxCutoverRefusedError extends Error {}

export async function readWithin<T extends { ok: boolean }>(ms: number, read: () => Promise<T>): Promise<T | { ok: false; reason: 'timeout'; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<{ ok: false; reason: 'timeout'; message: string }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', message: `the store did not answer within ${Math.round(ms / 1000)} seconds` }), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}


/**
 * THE CUTOVER MUST RESOLVE TO THIS READ. For every active foreign currency that is not pinned by a manual override, the real lookup at the cutover instant must give exactly the rate and the time of the
 * Aelia read that this cutover ingested; a different rate or time means something else (a newer or conflicting stored row) is what the lookup would use, so the switch is refused. A pinned currency is judged
 * by the lookup alone. Returns one text per mismatch (empty = all agree).
 */
export function cutoverReadMismatches(
  outcomes: ReadonlyMap<string, { ok: true; rate: { toString(): string; equals(other: string): boolean }; fetchedAt: Date } | { ok: false }>,
  read: { updatedAt: Date; readRates: Readonly<Record<string, string>>; pinned: readonly string[] },
): string[] {
  const pinned = new Set(read.pinned)
  const out: string[] = []
  for (const [code, outcome] of outcomes) {
    if (!outcome.ok || pinned.has(code)) continue
    const rate = read.readRates[code]
    if (rate === undefined) { out.push(`${code} (not in this read)`); continue }
    if (!outcome.rate.equals(rate) || outcome.fetchedAt.getTime() !== read.updatedAt.getTime()) {
      out.push(`${code} (resolves to ${outcome.rate.toString()} at ${outcome.fetchedAt.toISOString()}, this read has ${rate} at ${read.updatedAt.toISOString()})`)
    }
  }
  return out
}
