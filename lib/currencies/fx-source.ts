import { db } from '@/lib/db'

/**
 * WHICH SOURCE FEEDS fx_rates. One setting, default OFF.
 *
 *   'ecb'    (default, and anything unrecognised) the scheduled refresh fetches from frankfurter.dev; the IMS -> WooCommerce rate push works as it always did.
 *   'aelia'  the scheduled refresh READS the rates of the Aelia currency switcher through the helper plugin (lib/currencies/aelia-ingest.ts); the IMS -> WooCommerce rate push is DISABLED, so
 *            IMS never writes Aelia's rates. An unrecognised value is NOT 'aelia': the switch only turns on when it is exactly 'aelia'.
 */
export const FX_RATE_SOURCE_SETTING = 'fx_rate_source'
export const FX_RATE_SOURCES = ['ecb', 'aelia'] as const
export type FxRateSource = (typeof FX_RATE_SOURCES)[number]

export const AELIA_PUSH_DISABLED_MESSAGE = 'The FX source is Aelia: Aelia owns the exchange rates, so IMS does not push rates to WooCommerce.'

export function parseFxRateSource(value: string | null | undefined): FxRateSource {
  return value === 'aelia' ? 'aelia' : 'ecb'
}

export async function getFxRateSource(): Promise<FxRateSource> {
  const row = await db.setting.findUnique({ where: { key: FX_RATE_SOURCE_SETTING }, select: { value: true } })
  return parseFxRateSource(row?.value)
}
