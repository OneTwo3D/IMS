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

