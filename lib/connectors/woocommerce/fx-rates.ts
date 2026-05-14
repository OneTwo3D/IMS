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
import { connectorFetch } from '@/lib/security/connector-fetch'
import { getSettingValues } from '@/lib/settings-store'
import type { FxRatePush, FxRatePushResult } from '../types'
import { validateWooCommerceBaseUrl } from './url-safety'

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
  const validatedUrl = validateWooCommerceBaseUrl(url)
  if (!validatedUrl.ok) {
    return { supported: true, pushed: 0, errors: [validatedUrl.error] }
  }

  if (!rates.length) return { supported: true, pushed: 0, errors: [] }

  const body = JSON.stringify({ rates })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const endpoint = validatedUrl.normalizedUrl + HELPER_PATH

  try {
    const res = await connectorFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OTI-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    }, {
      connectorName: 'WooCommerce',
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

export type FxHelperPluginProbe = {
  status: 'OK' | 'NOT_INSTALLED' | 'BAD_SECRET' | 'NOT_CONFIGURED' | 'UNREACHABLE'
  httpStatus?: number
  message: string
}

/**
 * Pre-flight probe used during the unified-FX cutover. POSTs a deliberately
 * invalid HMAC signature to the helper plugin's FX endpoint:
 *
 *   - 401 with `oti_fx_bad_sig`     → plugin installed, secret set on the WP
 *                                      side, signing scheme matches → OK.
 *   - 401 with `oti_fx_no_secret`   → plugin installed but the operator
 *                                      hasn't pasted the secret yet.
 *   - 404 / 405                     → endpoint not registered, plugin missing
 *                                      or inactive.
 *   - anything else                 → unreachable / unexpected.
 *
 * The probe never sends real data and is safe to run on demand from the UI.
 */
export async function probeFxHelperPlugin(): Promise<FxHelperPluginProbe> {
  const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
  const url = config.get('wc_url') ?? ''
  if (!url) {
    return { status: 'NOT_CONFIGURED', message: 'WooCommerce store URL is not set in Sync settings.' }
  }
  const validatedUrl = validateWooCommerceBaseUrl(url)
  if (!validatedUrl.ok) {
    return { status: 'NOT_CONFIGURED', message: validatedUrl.error }
  }
  const endpoint = validatedUrl.normalizedUrl + HELPER_PATH

  // Send a body the plugin will reject — empty rates list, deliberately
  // invalid HMAC. We're testing the plugin layer, not the rate logic.
  const body = JSON.stringify({ rates: [] })

  let res: Response | null = null
  try {
    res = await connectorFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OTI-Signature': '0'.repeat(64),
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    }, {
      connectorName: 'WooCommerce',
    })
  } catch (e) {
    return {
      status: 'UNREACHABLE',
      message: `Could not reach ${endpoint}: ${String(e).slice(0, 200)}`,
    }
  }

  if (res.status === 401) {
    const text = await res.text().catch(() => '')
    if (/oti_fx_no_secret/.test(text)) {
      return {
        status: 'BAD_SECRET',
        httpStatus: 401,
        message: 'Plugin reachable, but no shared secret is configured on the WordPress side. In WP admin go to Settings → onetwoInventory and paste the secret shown in the IMS WC sync page.',
      }
    }
    return {
      status: 'OK',
      httpStatus: 401,
      message: 'Helper plugin is installed and the FX endpoint is wired. Signature verification is active.',
    }
  }

  if (res.status === 404 || res.status === 405) {
    return {
      status: 'NOT_INSTALLED',
      httpStatus: res.status,
      message: 'Endpoint /wp-json/oti/v1/fx-rates not found. Install and activate the onetwoInventory Helper plugin in WordPress.',
    }
  }

  // 200 should not happen for an invalid signature — the plugin would only
  // reach the success path if signature verification was bypassed. Treat as
  // a misconfiguration rather than success.
  if (res.status === 200) {
    return {
      status: 'BAD_SECRET',
      httpStatus: 200,
      message: 'Plugin replied 200 to an invalid signature. Signature verification is not active on the WP side — confirm the plugin version and the shared secret.',
    }
  }

  return {
    status: 'UNREACHABLE',
    httpStatus: res.status,
    message: `Unexpected HTTP ${res.status} from ${endpoint}. Check that the WordPress site is reachable from IMS.`,
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
