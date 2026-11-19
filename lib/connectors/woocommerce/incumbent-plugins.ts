/**
 * THE INCUMBENTS PROBE: ASK THE STOREFRONT WHETHER THE LEGACY BRIDGE PLUGIN AND XEROOM'S ORDER NOTE ARE STILL WRITING.
 *
 * GET <store>/wp-json/oti/v1/incumbents on the onetwoInventory Helper plugin (1.5.0 or later). READ ONLY: the route writes nothing and this module has
 * no method parameter. The request is signed with the shared secret (`wc_webhook_secret`) over `timestamp \n GET \n path \n nonce` (headers
 * X-OTI-Timestamp, X-OTI-Nonce, X-OTI-Signature); the plugin accepts it inside a 60 second window and once.
 *
 * The answer is reduced to a closed shape here and judged by the pure functions below. Whether the bridge plugin is ACTIVE is not a signal (it can
 * be active and silent, or deactivated while its timer still runs). The signals are: its REST routes registered (read from the server's own route
 * table, so it holds however the plugin is loaded), its order-sync switch, its product webhook, pending product-sync jobs and the latest write it
 * stamped on an order; and, for Xeroom, the option that the o3d mu-plugin reads to suppress Xeroom's WooCommerce order note.
 *
 * INERT UNTIL ITS STEP IS LIVE: nothing in IMS calls this except the `writers:check` evidence readers, and they call it only once the switchover step
 * that needs it is live (lib/ops/writers-check-step-evidence.ts).
 */

import { createHmac, randomBytes } from 'node:crypto'

import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'
import { getSettingValues } from '@/lib/settings-store'
import { validateWooCommerceBaseUrl } from './url-safety'
import { helperReadHopRefusal, INCUMBENTS_PATH } from './aelia-rates'

export { INCUMBENTS_PATH }
/** The replay window of the probe in the plugin (OTI_INCUMBENTS_WINDOW). */
export const INCUMBENTS_WINDOW_S = 60
const PROBE_TIMEOUT_MS = 15_000

/** The bridge plugin's exact slug. A prefix or a look-alike is not it. */
export const BRIDGE_PLUGIN_SLUG = 'wc-mintsoft-sync'

/** What the storefront reported, each field null when the plugin could not read it. */
export type IncumbentsProbe = {
  generatedAt: number | null
  bridge: {
    slug: string | null
    pluginActive: boolean | null
    routesRegistered: boolean | null
    orderSyncEnabled: boolean | null
    productWebhook: { total: number; active: number } | null
    pendingProductJobs: number | null
    /** Unix seconds of the newest bridge link-meta time the bridge stamped on an order (0 = never). */
    latestMintsoftWrite: number | null
  }
  xeroom: { orderNoteOff: boolean | null; orderNoteOffPresent: boolean | null }
}

export type IncumbentsProbeResult =
  | { ok: true; probe: IncumbentsProbe }
  | { ok: false; reason: 'not_configured' | 'unreachable' | 'http_status' | 'not_json' | 'malformed'; message: string }

/** The signature the plugin checks. Exported so the tests (and the plugin's PHP test) sign the same way. */
export function signIncumbentsProbe(input: { timestamp: number; nonce: string }, secret: string): string {
  return createHmac('sha256', secret).update(`${input.timestamp}\nGET\n${INCUMBENTS_PATH}\n${input.nonce}`).digest('hex')
}

const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** Reduce the plugin's answer to the closed shape. Anything unexpected is null (never a guess); an answer that is not the success shape is malformed. */
export function parseIncumbentsProbe(body: unknown): IncumbentsProbe | null {
  const root = record(body)
  if (!root || root.ok !== true) return null
  const bridge = record(root.bridge)
  const xeroom = record(root.xeroom)
  if (!bridge || !xeroom) return null
  const hook = record(bridge.product_webhook)
  const total = hook ? count(hook.total) : null
  const active = hook ? count(hook.active) : null
  return {
    generatedAt: count(root.generated_at),
    bridge: {
      slug: typeof bridge.slug === 'string' ? bridge.slug : null,
      pluginActive: bool(bridge.plugin_active),
      routesRegistered: bool(bridge.routes_registered),
      orderSyncEnabled: bool(bridge.order_sync_enabled),
      productWebhook: total !== null && active !== null ? { total, active } : null,
      pendingProductJobs: count(bridge.pending_product_jobs),
      latestMintsoftWrite: count(bridge.latest_mintsoft_write),
    },
    xeroom: { orderNoteOff: bool(xeroom.order_note_off), orderNoteOffPresent: bool(xeroom.order_note_off_present) },
  }
}

export type IncumbentsProbeDeps = {
  /** Test seam: the fetch seam itself. */
  fetchImpl?: typeof connectorFetch
  /** Test seam: the settings. Absent = the stored settings. */
  settings?: { url: string; secret: string }
  env?: ConnectorFetchOptions['env']
  now?: () => number
  nonce?: () => string
}

export async function fetchIncumbentsProbe(deps: IncumbentsProbeDeps = {}): Promise<IncumbentsProbeResult> {
  let url: string
  let secret: string
  if (deps.settings) ({ url, secret } = deps.settings)
  else {
    const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
    url = config.get('wc_url') ?? ''
    secret = config.get('wc_webhook_secret') ?? ''
  }
  if (!url || !secret) return { ok: false, reason: 'not_configured', message: 'WooCommerce URL or webhook secret not configured' }
  const validated = validateWooCommerceBaseUrl(url)
  if (!validated.ok) return { ok: false, reason: 'not_configured', message: validated.error }

  const base = new URL(validated.normalizedUrl)
  const endpoint = new URL(validated.normalizedUrl.replace(/\/+$/, '') + INCUMBENTS_PATH)
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const nonce = (deps.nonce ?? (() => randomBytes(16).toString('hex')))()
  let res: Response
  try {
    res = await (deps.fetchImpl ?? connectorFetch)(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-OTI-Timestamp': String(timestamp), 'X-OTI-Nonce': nonce, 'X-OTI-Signature': signIncumbentsProbe({ timestamp, nonce }, secret) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }, { connectorName: 'WooCommerce', env: deps.env, refuseRedirects: true, hopGate: (hop) => helperReadHopRefusal(base, hop) })
  } catch (error) {
    return { ok: false, reason: 'unreachable', message: `Could not probe the storefront: ${error instanceof Error ? error.name : 'unknown error'}.` }
  }
  if (res.status < 200 || res.status > 299) {
    return { ok: false, reason: 'http_status', message: `The helper plugin answered HTTP ${res.status}. Is onetwoInventory Helper 1.5.0 or later installed and active, with the shared secret set?` }
  }
  let body: unknown
  try { body = await res.json() } catch { return { ok: false, reason: 'not_json', message: 'The helper plugin did not answer with JSON.' } }
  const probe = parseIncumbentsProbe(body)
  return probe ? { ok: true, probe } : { ok: false, reason: 'malformed', message: 'The helper plugin answered, but not with the incumbents shape.' }
}

/** The violated expectations of the BRIDGE for step M, by closed code. An unreadable field is its own code (never taken as fine). */
export type BridgeProbeInput = { probe: IncumbentsProbe; mintsoftLiveFrom: Date }

export function bridgeProbeViolations({ probe, mintsoftLiveFrom }: BridgeProbeInput): string[] {
  const out: string[] = []
  const b = probe.bridge
  if (b.slug !== BRIDGE_PLUGIN_SLUG) out.push('bridge-slug-unexpected')
  if (b.routesRegistered === null) out.push('bridge-routes-unreadable')
  else if (b.routesRegistered) out.push('bridge-routes-registered')
  if (b.orderSyncEnabled === null) out.push('bridge-order-sync-unreadable')
  else if (b.orderSyncEnabled) out.push('bridge-order-sync-enabled')
  if (b.productWebhook === null) out.push('bridge-product-webhook-unreadable')
  else if (b.productWebhook.active > 0) out.push('bridge-product-webhook-active')
  if (b.pendingProductJobs === null) out.push('bridge-product-jobs-unreadable')
  else if (b.pendingProductJobs > 0) out.push('bridge-product-jobs-pending')
  if (b.latestMintsoftWrite === null) out.push('bridge-last-write-unreadable')
  else if (b.latestMintsoftWrite * 1000 >= mintsoftLiveFrom.getTime()) out.push('bridge-wrote-after-live-from')
  return out
}

/** The violated expectations of XEROOM's note for step X. Absent option = the default (the note is on): a violation. */
export function xeroomNoteViolations(probe: IncumbentsProbe): string[] {
  if (probe.xeroom.orderNoteOff === null) return ['xeroom-note-option-unreadable']
  return probe.xeroom.orderNoteOff ? [] : ['xeroom-note-on']
}
