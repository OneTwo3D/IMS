/**
 * Push FX rates from IMS to a WooCommerce store running the
 * "onetwoInventory Helper" companion plugin.
 *
 * Endpoint: POST /wp-json/oti/v1/fx-rates
 * Auth: HMAC-SHA256 of the raw JSON body, hex-encoded, sent as
 *       `X-OTI-Signature`. The shared secret is the same value used for
 *       WooCommerce webhooks (`wc_webhook_secret` setting), pasted into the
 *       plugin's settings page.
 *
 * Connector-agnostic in shape: accepts the generic `FxRatePush[]` from
 * `lib/connectors/types.ts`, returns the generic `FxRatePushResult`. The
 * helper-plugin URL convention (`/wp-json/oti/v1/...`) is internal to the
 * WooCommerce adapter — switching to a different shopping platform later
 * means writing a new adapter, not changing IMS callers.
 */

import { createHmac } from 'node:crypto'

import { db } from '@/lib/db'
import { getSettingValues } from '@/lib/settings-store'
import type { FxRatePush, FxRatePushResult } from '../types'

const HELPER_PATH = '/wp-json/oti/v1/fx-rates'
const PUSH_TIMEOUT_MS = 15_000

/**
 * Send the current rate set to the WC helper plugin. Safe to call when WC is
 * not configured — returns `{ supported: false }` rather than throwing, so the
 * cron fan-out can iterate over enabled connectors without special-casing.
 */
export async function pushFxRatesToWc(rates: FxRatePush[]): Promise<FxRatePushResult> {
  const config = await getSettingValues(['wc_url', 'wc_webhook_secret', 'wc_fx_push_enabled'])
  const url = config.get('wc_url') ?? ''
  const secret = config.get('wc_webhook_secret') ?? ''
  const enabled = config.get('wc_fx_push_enabled') === 'true'

  if (!enabled) return { supported: false, pushed: 0, errors: [] }
  if (!url || !secret) {
    return { supported: false, pushed: 0, errors: ['WooCommerce URL or webhook secret not configured'] }
  }

  if (!rates.length) return { supported: true, pushed: 0, errors: [] }

  const body = JSON.stringify({ rates })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const endpoint = url.replace(/\/+$/, '') + HELPER_PATH

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OTI-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        supported: true,
        pushed: 0,
        errors: [`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`],
      }
    }

    const json = (await res.json().catch(() => ({}))) as { pushed?: number; ok?: boolean }
    return { supported: true, pushed: Number(json.pushed ?? rates.length), errors: [] }
  } catch (e) {
    return { supported: true, pushed: 0, errors: [String(e)] }
  }
}

/**
 * Read the current rate set from the IMS DB and push it.
 *
 * Used by the FX cron after a successful inbound fetch, and by the manual
 * "Push now" button in settings.
 */
export async function pushCurrentFxRatesToWc(): Promise<FxRatePushResult> {
  const baseSetting = await db.organisation.findFirst({ select: { baseCurrency: true } })
  const base = baseSetting?.baseCurrency ?? 'GBP'

  // Latest rate per toCurrency. The FxRate table is append-only, so we group
  // by toCurrency and take the newest fetchedAt.
  const all = await db.fxRate.findMany({
    where: { fromCurrency: base },
    orderBy: { fetchedAt: 'desc' },
    select: { toCurrency: true, rate: true, fetchedAt: true },
  })
  const seen = new Set<string>()
  const rates: FxRatePush[] = []
  for (const row of all) {
    if (seen.has(row.toCurrency)) continue
    seen.add(row.toCurrency)
    rates.push({
      fromCurrency: base,
      toCurrency: row.toCurrency,
      rate: Number(row.rate),
      fetchedAt: row.fetchedAt.toISOString(),
    })
  }
  return pushFxRatesToWc(rates)
}
