/**
 * A REDIRECT-AWARE, HOLD-AWARE `fetch` FOR PROCESSES THAT CANNOT USE connectorFetch.
 *
 * Operator scripts (scripts/) and the end-to-end harness (e2e/) talk to WooCommerce and Xero with their own
 * credentials and are outside the connector transport. They are still IMS processes, and the outbound-write
 * hold (lib/security/outbound-write-grant.ts) applies to them exactly as it does to the application:
 *
 *  - the decision is taken for EVERY hop, as the last step before that hop's request is sent;
 *  - redirects are followed MANUALLY (`redirect: 'manual'`), because native `fetch` follows a 307/308 with the
 *    method and body intact and would carry a granted write to a destination nobody granted;
 *  - a refusal throws OutboundWriteHeldError (hop 0: nothing sent; hop >= 1: the first request was sent).
 *
 * It is NOT an SSRF-safe client - there is no DNS or address validation - which is why application code must
 * keep using connectorFetch. tests/security/outbound-write-hold-raw-fetch.test.ts fails when a script or an
 * e2e file sends a non-GET request with a bare `fetch` instead of this.
 */

import { OutboundWriteHeldError, outboundWriteRefusal, type OutboundEnv } from './outbound-write-grant'

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type GuardedExternalFetchOptions = {
  /** The connector this request is for, named as connectorFetch names it. */
  connectorName: string
  /** The write-scope id (client/account id) the process is configured with, where the connector scopes writes by one. */
  writeScopeId?: string | number | null
  env?: OutboundEnv
}

export async function guardedExternalFetch(
  input: string | URL,
  init: RequestInit = {},
  options: GuardedExternalFetchOptions,
): Promise<Response> {
  let url = input instanceof URL ? input : new URL(input)
  let method = (init.method ?? 'GET').toUpperCase()
  let headers = new Headers(init.headers)
  // Like connectorFetch, this never modifies a request body.
  let body = init.body

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = outboundWriteRefusal({
      connectorName: options.connectorName,
      method,
      url,
      headers,
      body,
      writeScopeId: options.writeScopeId,
      env: options.env,
    })
    if (refusal) throw new OutboundWriteHeldError(refusal, hop)

    const response = await fetch(url, { ...init, method, headers, body, redirect: 'manual' })
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null
    if (!location) return response
    if (hop === MAX_REDIRECTS) throw new Error(`${options.connectorName} request exceeded ${MAX_REDIRECTS} redirects.`)

    const next = new URL(location, url)
    const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')
    if (next.origin !== url.origin) {
      headers = new Headers(headers)
      headers.delete('authorization')
      headers.delete('cookie')
      headers.delete('proxy-authorization')
    }
    if (toGet) {
      method = 'GET'
      body = undefined
      headers = new Headers(headers)
      headers.delete('content-length')
      headers.delete('content-type')
    }
    url = next
  }
  throw new Error(`${options.connectorName} request exceeded ${MAX_REDIRECTS} redirects.`)
}
