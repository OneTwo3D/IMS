/**
 * THE VENDOR TRANSPORT FOR WOOCOMMERCE: GET only, through the connector fetch seam, to a short list of paths and parameters.
 *
 * No `fetch(` of its own: every request is `connectorFetch` (lib/security/connector-fetch.ts), which validates the URL and every DNS
 * answer, bounds the response size and time, and runs the outbound-write hold on each hop. On top of that, this module gives the
 * seam a `hopGate` that refuses, before anything is sent, every request that is not exactly
 *
 *     GET  <store base>/wp-json/wc/v3/(orders|products|taxes)?<only status, page, per_page, orderby, order, _fields>
 *
 * with plain-valued parameters and the store's own origin, and `refuseRedirects`, so a redirect is an error and its target is never
 * requested. The method is not a parameter of this module at all: a write cannot be asked for through it. The credentials are read
 * only on the first request (woo-credentials.ts) and only into the Authorization header; nothing about a response but its status,
 * the two pagination headers and the parsed JSON is returned, and no error text, URL or body is kept.
 */

import {
  WOO_READ_COLLECTIONS,
  WOO_READ_PARAMS,
  WOO_REQUEST_TIMEOUT_MS,
  type WooCollection,
} from '@/lib/reconciliation-pack/constants'
import type { WooCredentials } from '@/lib/reconciliation-pack/woo-credentials'
import type { WooGetPort, WooPage } from '@/lib/reconciliation-pack/woo-source'
import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'

const PARAM_VALUE_RE = /^[A-Za-z0-9_,.-]{1,128}$/

export type WooTransportDeps = {
  /** Reads the credentials on first use. null = not configured / not trusted: no request is made. */
  readCredentials: () => Promise<WooCredentials | null>
  /** Test seam: the environment the fetch seam judges (E2E loopback). Absent = the process environment. */
  env?: ConnectorFetchOptions['env']
  /** Test seam: the fetch seam itself. */
  fetchImpl?: typeof connectorFetch
  timeoutMs?: number
}

/** The decision the hop gate makes for one hop. A string refuses the hop (nothing is sent). Exported so a test drives it directly. */
export function wooHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.method !== 'GET') return 'method'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = `${base.pathname.replace(/\/+$/, '')}/wp-json/wc/v3/`
  if (!hop.url.pathname.startsWith(prefix)) return 'path'
  const collection = hop.url.pathname.slice(prefix.length)
  if (!(WOO_READ_COLLECTIONS as readonly string[]).includes(collection)) return 'path'
  const seen = new Set<string>()
  for (const [name, value] of hop.url.searchParams) {
    if (!(WOO_READ_PARAMS as readonly string[]).includes(name) || seen.has(name) || !PARAM_VALUE_RE.test(value)) return 'parameter'
    seen.add(name)
  }
  return null
}

export function createWooGetPort(deps: WooTransportDeps): WooGetPort {
  const send = deps.fetchImpl ?? connectorFetch
  let credentials: Promise<WooCredentials | null> | null = null
  return {
    async get(collection: WooCollection, params: Readonly<Record<string, string>>): Promise<WooPage> {
      try {
        if (!(WOO_READ_COLLECTIONS as readonly string[]).includes(collection)) return { ok: false }
        credentials ??= deps.readCredentials().catch(() => null)
        const creds = await credentials
        if (creds === null) return { ok: false }
        const base = new URL(creds.baseUrl)
        const url = new URL(`${creds.baseUrl.replace(/\/+$/, '')}/wp-json/wc/v3/${collection}`)
        for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
        const auth = Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')
        const response = await send(url, {
          method: 'GET',
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(deps.timeoutMs ?? WOO_REQUEST_TIMEOUT_MS),
        }, {
          connectorName: 'WooCommerce',
          allowE2eLocalHttp: true,
          env: deps.env,
          refuseRedirects: true,
          hopGate: (hop) => wooHopRefusal(base, hop),
        })
        if (response.status < 200 || response.status > 299) return { ok: false }
        if (!(response.headers.get('content-type') ?? '').includes('application/json')) return { ok: false }
        const body: unknown = await response.json()
        return { ok: true, status: response.status, total: response.headers.get('x-wp-total'), totalPages: response.headers.get('x-wp-totalpages'), body }
      } catch {
        return { ok: false }
      }
    },
  }
}
