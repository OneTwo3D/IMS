import { db } from '@/lib/db'
import {
  FX_RATE_SOURCE_HISTORY_SETTING, FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCES, getFxSourceRegime, parseFxRateSource,
  type FxRateSource, type FxSourceRegime,
} from '@/lib/currencies/fx-source-regime'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * WHICH SOURCE FEEDS fx_rates. One setting, default OFF.
 *
 *   'ecb'    (default, and anything unrecognised) the scheduled refresh fetches from frankfurter.dev; the IMS -> WooCommerce rate push works as it always did.
 *   'aelia'  the scheduled refresh READS the rates of the Aelia currency switcher through the helper plugin (lib/currencies/aelia-ingest.ts); the IMS -> WooCommerce rate push is DISABLED, so
 *            IMS never writes Aelia's rates. An unrecognised value is NOT 'aelia': the switch only turns on when it is exactly 'aelia'.
 */
export { FX_RATE_SOURCE_HISTORY_SETTING, FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCES, parseFxRateSource, type FxRateSource }

export const AELIA_PUSH_DISABLED_MESSAGE = 'The FX source is Aelia: Aelia owns the exchange rates, so IMS does not push rates to WooCommerce.'

export async function getFxRateSource(): Promise<FxRateSource> {
  const row = await db.setting.findUnique({ where: { key: FX_RATE_SOURCE_SETTING }, select: { value: true } })
  return parseFxRateSource(row?.value)
}

/** The source as seen from INSIDE a transaction (the FX table write lock): the barrier a writer re-checks after taking the lock. */
export async function getFxRateSourceInTx(tx: Pick<Prisma.TransactionClient, 'setting'>): Promise<FxRateSource> {
  const row = await tx.setting.findUnique({ where: { key: FX_RATE_SOURCE_SETTING }, select: { value: true } })
  return parseFxRateSource(row?.value)
}

export const FX_SOURCE_CHANGED_MESSAGE = 'The FX source changed to Aelia while this ran; nothing was stored.'

export async function getCurrentFxSourceRegime(): Promise<FxSourceRegime> {
  return getFxSourceRegime(db)
}
