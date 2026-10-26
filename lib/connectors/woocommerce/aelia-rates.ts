/**
 * THE READ OF AELIA'S RATE TABLE through the onetwoInventory Helper plugin.
 *
 * GET <store base>/wp-json/oti/v1/aelia-rates, authenticated like the plugin's other signed endpoints: HMAC-SHA256 of the raw body (EMPTY for a GET), hex, in `X-OTI-Signature`, keyed with the
 * shared secret (`wc_webhook_secret`).
 *
 * THE TRANSPORT GUARDS. Every request is `connectorFetch` (URL and DNS validation, size and time bounds, the outbound-write hold on each hop). On top of that this module gives the seam a `hopGate`
 * built from HELPER_READ_ALLOWLIST: the GET allowlist for the plugin's own namespace, ONE path with FIXED parameters (none). Anything else, any other method, a foreign origin, a query string,
 * credentials in the URL, a fragment or a redirect is refused BEFORE it is sent, and `refuseRedirects` makes a redirect an error whose target is never requested. The method is not a parameter
 * of this module: a write cannot be asked for through it.
 *
 * This module only fetches and returns the parsed JSON; it decides nothing about the rates (lib/currencies/aelia-ingest.ts validates every field).
 */

import { createHmac } from 'node:crypto'

import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from './url-safety'

export const AELIA_RATES_PATH = '/wp-json/oti/v1/aelia-rates'
const READ_TIMEOUT_MS = 15_000

/** The GET allowlist for the helper plugin's namespace: exact path -> the query parameters allowed on it (name -> the one value it may carry). Adding a read adds a row HERE. */
export const HELPER_READ_ALLOWLIST: ReadonlyArray<{ path: string; params: Readonly<Record<string, string>> }> = [
  { path: AELIA_RATES_PATH, params: {} },
]

/** The decision the hop gate makes for one hop. A string refuses the hop (nothing is sent). Exported so a test drives it directly. */
export function helperReadHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.method !== 'GET') return 'method'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = base.pathname.replace(/\/+$/, '')
  const rule = HELPER_READ_ALLOWLIST.find((r) => hop.url.pathname === `${prefix}${r.path}`)
  if (!rule) return 'path'
  const seen = new Set<string>()
  for (const [name, value] of hop.url.searchParams) {
    if (seen.has(name) || rule.params[name] !== value) return 'parameter'
    seen.add(name)
  }
  return null
}

export type AeliaRatesReadResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: 'not_configured' | 'unreachable' | 'http_status' | 'not_json'; message: string }

export type AeliaRatesReadDeps = {
  /** Test seam: the fetch seam itself. */
  fetchImpl?: typeof connectorFetch
  /** Test seam: the settings. Absent = the stored settings. */
  settings?: { url: string; secret: string }
  env?: ConnectorFetchOptions['env']
}

export async function readAeliaRatesFromWc(deps: AeliaRatesReadDeps = {}): Promise<AeliaRatesReadResult> {
  let url: string
  let secret: string
  if (deps.settings) {
    ({ url, secret } = deps.settings)
  } else {
    const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
    url = config.get('wc_url') ?? ''
    secret = config.get('wc_webhook_secret') ?? ''
  }
  if (!url || !secret) return { ok: false, reason: 'not_configured', message: 'WooCommerce URL or webhook secret not configured' }
  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { ok: false, reason: 'not_configured', message: validated.error }

  const base = new URL(validated.normalizedUrl)
  const endpoint = new URL(validated.normalizedUrl.replace(/\/+$/, '') + AELIA_RATES_PATH)
  const signature = createHmac('sha256', secret).update('').digest('hex')
  const send = deps.fetchImpl ?? connectorFetch
  let res: Response
  try {
    res = await send(endpoint, {
      method: 'GET',
      headers: { 'X-OTI-Signature': signature, Accept: 'application/json' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }, {
      connectorName: 'WooCommerce',
      env: deps.env,
      refuseRedirects: true,
      hopGate: (hop) => helperReadHopRefusal(base, hop),
    })
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: `Could not read Aelia's rates: ${String(e).slice(0, 200)}` }
  }
  if (res.status < 200 || res.status > 299) {
    return { ok: false, reason: 'http_status', message: `The helper plugin answered HTTP ${res.status}. Is onetwoInventory Helper 1.3.0 or later installed and active, with the shared secret set?` }
  }
  try {
    return { ok: true, body: await res.json() }
  } catch {
    return { ok: false, reason: 'not_json', message: 'The helper plugin did not answer with JSON.' }
  }
}
