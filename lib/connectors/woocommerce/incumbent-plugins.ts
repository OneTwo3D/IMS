/**
 * THE READ OF "IS ANOTHER WRITER STILL SWITCHED ON?" through the onetwoInventory Helper plugin.
 *
 * GET <store base>/wp-json/oti/v1/incumbents (helper plugin 1.5.0 or later), signed like the plugin's other endpoints (HMAC-SHA256 of the EMPTY body, hex, `X-OTI-Signature`, keyed with
 * `wc_webhook_secret`). The plugin answers three booleans: whether the legacy bridge (legacy bridge), the Xeroom invoicing plugin and the IOSS/Xero plugin are active on the site.
 *
 * Read only: every request is `connectorFetch` with a hop gate that allows ONE path, no parameters, GET only, no redirect, the store's own origin. The method is not a parameter of this
 * module, so a write cannot be asked for through it.
 *
 * FAIL CLOSED: only a body that PROVES the three states is a reading. A missing field, a non-boolean, an unexpected schema, an HTTP error or an unreachable site is `unreadable`, never "inactive".
 */

import { createHmac } from 'node:crypto'

import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from './url-safety'

export const INCUMBENT_PLUGINS_PATH = '/wp-json/oti/v1/incumbents'
const READ_TIMEOUT_MS = 15_000

export const INCUMBENT_PLUGIN_NAMES = ['legacy_bridge', 'xeroom', 'ioss_xero'] as const
export type IncumbentPluginName = (typeof INCUMBENT_PLUGIN_NAMES)[number]

export type IncumbentPluginsReading =
  | { state: 'read'; active: Record<IncumbentPluginName, boolean> }
  | { state: 'unreadable'; reason: string }
  /** The probe was not attempted (no storefront connection to ask). Not a reading of anything. */
  | { state: 'not-probed'; reason: string }

/** The decision the hop gate makes for one hop. A string refuses the hop (nothing is sent). */
export function incumbentPluginsHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.method !== 'GET') return 'method'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  if (hop.url.pathname !== `${base.pathname.replace(/\/+$/, '')}${INCUMBENT_PLUGINS_PATH}`) return 'path'
  if ([...hop.url.searchParams].length > 0) return 'parameter'
  return null
}

/** Pure. Anything that is not exactly the documented shape is unreadable. */
export function classifyIncumbentPluginsBody(body: unknown): IncumbentPluginsReading {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { state: 'unreadable', reason: 'the answer is not an object' }
  const record = body as { ok?: unknown; schema?: unknown; active?: unknown }
  if (record.ok !== true || record.schema !== 1) return { state: 'unreadable', reason: 'the answer is not schema 1' }
  if (typeof record.active !== 'object' || record.active === null || Array.isArray(record.active)) return { state: 'unreadable', reason: 'the answer has no active map' }
  const active = {} as Record<IncumbentPluginName, boolean>
  for (const name of INCUMBENT_PLUGIN_NAMES) {
    const value = (record.active as Record<string, unknown>)[name]
    if (typeof value !== 'boolean') return { state: 'unreadable', reason: `the answer does not state ${name} as true or false` }
    active[name] = value
  }
  return { state: 'read', active }
}

export type IncumbentPluginsReadDeps = {
  fetchImpl?: typeof connectorFetch
  settings?: { url: string; secret: string }
  env?: ConnectorFetchOptions['env']
}

export async function readIncumbentPluginsFromWc(deps: IncumbentPluginsReadDeps = {}): Promise<IncumbentPluginsReading> {
  let url: string
  let secret: string
  if (deps.settings) {
    ({ url, secret } = deps.settings)
  } else {
    const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
    url = config.get('wc_url') ?? ''
    secret = config.get('wc_webhook_secret') ?? ''
  }
  if (!url || !secret) return { state: 'not-probed', reason: 'WooCommerce URL or webhook secret not configured' }
  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { state: 'not-probed', reason: validated.error }

  const base = new URL(validated.normalizedUrl)
  const endpoint = new URL(validated.normalizedUrl.replace(/\/+$/, '') + INCUMBENT_PLUGINS_PATH)
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
      hopGate: (hop) => incumbentPluginsHopRefusal(base, hop),
    })
  } catch (e) {
    return { state: 'unreadable', reason: `Could not ask the storefront: ${String(e).slice(0, 200)}` }
  }
  if (res.status < 200 || res.status > 299) {
    return { state: 'unreadable', reason: `The helper plugin answered HTTP ${res.status}. Is onetwoInventory Helper 1.5.0 or later installed and active, with the shared secret set?` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { state: 'unreadable', reason: 'The helper plugin did not answer with JSON.' }
  }
  return classifyIncumbentPluginsBody(body)
}
