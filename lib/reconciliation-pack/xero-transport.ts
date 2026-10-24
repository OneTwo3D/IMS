/**
 * THE VENDOR TRANSPORT FOR XERO: GET only, through the connector fetch seam, to two resources and a short list of parameters.
 *
 * No `fetch(` of its own: every request is `connectorFetch` (lib/security/connector-fetch.ts), which validates the URL and every DNS
 * answer, bounds the response size and time, and runs the outbound-write hold on each hop. On top of that this module gives the seam a
 * `hopGate` that refuses, before anything is sent, every request that is not exactly
 *
 *     GET  https://api.xero.com/api.xro/2.0/(Organisation | Invoices)?<only where, Statuses, page>
 *
 * with the one `where` shape the pack builds (sales invoices in a date window), a plain `Statuses` list and a whole-number `page`, and
 * `refuseRedirects`, so a redirect is an error and its target is never requested. The method is not a parameter of this module: a write
 * cannot be asked for through it. It does not use the connector's own client (lib/connectors/xero/api.ts), which refreshes tokens and
 * keeps rate-limit state in the database (writes); the budget and the pacing are the walker's (xero-source.ts). The token is read only
 * on the first request (xero-credentials.ts) and goes only into the Authorization header. Nothing about a response but its status and
 * its parsed JSON is returned, and no error text, URL or body is kept.
 */

import { R12_XERO_INVOICE_STATUSES, XERO_API_BASE_URL, XERO_READ_PARAMS, XERO_READ_RESOURCES, XERO_REQUEST_TIMEOUT_MS, type XeroResource } from '@/lib/reconciliation-pack/constants'
import type { XeroAccess } from '@/lib/reconciliation-pack/xero-credentials'
import type { XeroGetPort, XeroPage } from '@/lib/reconciliation-pack/xero-source'
import { connectorFetch, type ConnectorFetchOptions } from '@/lib/security/connector-fetch'

export const XERO_WHERE_RE = /^Type=="ACCREC" AND Date>=DateTime\([1-9][0-9]{3}, [1-9][0-9]?, [1-9][0-9]?\) AND Date<DateTime\([1-9][0-9]{3}, [1-9][0-9]?, [1-9][0-9]?\)$/
const PAGE_RE = /^[1-9][0-9]{0,6}$/
const STATUSES_VALUE = R12_XERO_INVOICE_STATUSES.join(',')

export type XeroTransportDeps = {
  /** Reads the access on first use. null = not configured / not trusted / not current: no request is made. */
  readAccess: () => Promise<XeroAccess | null>
  /** Test seam: the base URL (a loopback double). The command never sets it. */
  baseUrl?: string
  /** Test seam: the environment the fetch seam judges (E2E loopback). Absent = the process environment. */
  env?: ConnectorFetchOptions['env']
  /** Test seam: the fetch seam itself. */
  fetchImpl?: typeof connectorFetch
  timeoutMs?: number
}

/** The decision the hop gate makes for one hop. A string refuses the hop (nothing is sent). Exported so a test drives it directly. */
export function xeroHopRefusal(base: URL, hop: { method: string; url: URL; redirectCount: number }): string | null {
  if (hop.redirectCount !== 0) return 'redirect'
  if (hop.method !== 'GET') return 'method'
  if (hop.url.origin !== base.origin || hop.url.username || hop.url.password || hop.url.hash) return 'origin'
  const prefix = `${base.pathname.replace(/\/+$/, '')}/`
  if (!hop.url.pathname.startsWith(prefix)) return 'path'
  const resource = hop.url.pathname.slice(prefix.length)
  if (!(XERO_READ_RESOURCES as readonly string[]).includes(resource)) return 'path'
  const seen = new Set<string>()
  for (const [name, value] of hop.url.searchParams) {
    if (!(XERO_READ_PARAMS as readonly string[]).includes(name) || seen.has(name)) return 'parameter'
    seen.add(name)
    if (name === 'where' && !XERO_WHERE_RE.test(value)) return 'parameter'
    if (name === 'Statuses' && value !== STATUSES_VALUE) return 'parameter'
    if (name === 'page' && !PAGE_RE.test(value)) return 'parameter'
  }
  // The organisation read takes no parameter at all; the invoice list takes all three.
  if (resource === 'Organisation' && seen.size !== 0) return 'parameter'
  if (resource === 'Invoices' && !(seen.has('where') && seen.has('Statuses') && seen.has('page'))) return 'parameter'
  return null
}

export function createXeroGetPort(deps: XeroTransportDeps): XeroGetPort {
  const send = deps.fetchImpl ?? connectorFetch
  const baseUrl = deps.baseUrl ?? XERO_API_BASE_URL
  let access: Promise<XeroAccess | null> | null = null
  return {
    async get(resource: XeroResource, params: Readonly<Record<string, string>>): Promise<XeroPage> {
      try {
        if (!(XERO_READ_RESOURCES as readonly string[]).includes(resource)) return { ok: false }
        access ??= deps.readAccess().catch(() => null)
        const grant = await access
        if (grant === null) return { ok: false }
        const base = new URL(baseUrl)
        const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${resource}`)
        for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
        const response = await send(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${grant.accessToken}`, 'Xero-Tenant-Id': grant.tenantId, Accept: 'application/json' },
          signal: AbortSignal.timeout(deps.timeoutMs ?? XERO_REQUEST_TIMEOUT_MS),
        }, {
          connectorName: 'Xero',
          allowE2eLocalHttp: true,
          env: deps.env,
          refuseRedirects: true,
          hopGate: (hop) => xeroHopRefusal(base, hop),
        })
        if (response.status < 200 || response.status > 299) return { ok: false }
        if (!(response.headers.get('content-type') ?? '').includes('application/json')) return { ok: false }
        const body: unknown = await response.json()
        return { ok: true, status: response.status, body }
      } catch {
        return { ok: false }
      }
    },
  }
}
