/**
 * THE OUTBOUND-WRITE HOLD: ONE DECISION, TAKEN AT THE HTTP BOUNDARY.
 *
 * WHAT IT DECIDES. Whether one outbound request to WooCommerce, Mintsoft or Xero may leave this
 * process. A request that cannot change anything at the destination (a READ) always may. A request
 * that could (a WRITE) may only if THIS INSTALLATION'S ENVIRONMENT has granted that exact destination:
 *
 *     WC_WRITEBACK_ALLOWED_ORIGIN   one store origin
 *     MINTSOFT_WRITE_ALLOWED        <base URL>|<ClientId>
 *     XERO_WRITE_ALLOWED_TENANT     one tenant id
 *
 * The properties that make it a control rather than a convention:
 *
 *  1. DEFAULT DENY. No variable, no write. An unreadable variable (a list, a wildcard, a boolean, a
 *     path, credentials, a malformed id) is no variable.
 *  2. ENVIRONMENT ONLY. Never a settings row. A database restore, a clone, a scratch database or a new
 *     worktree carries no environment, so none of them can inherit a grant made for another install.
 *  3. IT NAMES THE DESTINATION. A boolean would be satisfied by any URL, which is exactly the bug it
 *     replaces; this compares the grant with the destination of the request actually being made, so
 *     changing the store URL / Mintsoft base URL / Xero organisation revokes the permission.
 *  4. IT IS EVALUATED PER REQUEST, ON EVERY REDIRECT HOP (see connector-fetch.ts), as the last thing
 *     before the socket. A permission checked once before a loop is spent on a different request.
 *  5. IT CLASSIFIES BY WHAT A REQUEST DOES. WooCommerce: GET/HEAD read. Xero: GET to api.xero.com
 *     read, the identity token exchange allowed (it only lets us read), everything else write.
 *     Mintsoft: an explicit (method, path) allow-list of reads, because Mintsoft mutates through GET
 *     (see lib/connectors/mintsoft/api/read-allowlist.ts); everything not on it is a write.
 *
 * WHAT IT IS NOT: not authentication, not the SSRF layer (external-url-safety.ts still runs after
 * it), and not a switch for the writers themselves - it refuses their requests, it does not stop
 * them being attempted. See docs/installation.md for the operator description.
 *
 * Pure: no I/O, no database, no clock. Callers turn a refusal into an OutboundWriteHeldError.
 */

import {
  OUTBOUND_CONNECTORS,
  OUTBOUND_GRANT_ENV,
  outboundHeldMessage,
  type OutboundConnector,
  type OutboundWriteRefusalCode,
} from './outbound-write-hold-constants'
import { classifyMintsoftRequest, mintsoftRelativePath } from '@/lib/connectors/mintsoft/api/read-allowlist'

export type OutboundEnv = Record<string, string | undefined>

export type OutboundRequestClass = 'read' | 'write'

export type OutboundClassification = {
  connector: OutboundConnector
  class: OutboundRequestClass
  /** What decided it, for logs and tests. */
  basis: string
}

// ---------------------------------------------------------------------------------------------
// Which connector is this request for?
// ---------------------------------------------------------------------------------------------

const XERO_HOSTS = new Set(['api.xero.com', 'identity.xero.com', 'login.xero.com'])

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)]$/, '$1')
}

function connectorFromName(name: string | undefined): OutboundConnector | null {
  const lowered = (name ?? '').trim().toLowerCase()
  return (OUTBOUND_CONNECTORS as readonly string[]).includes(lowered) ? (lowered as OutboundConnector) : null
}

/**
 * The connector a request is governed as. The caller's `connectorName` is honoured, but a request to a
 * KNOWN VENDOR HOST is governed as that vendor whatever the caller called itself, so a call site that
 * mislabels itself (or a new one that forgets to) cannot take a Xero or Mintsoft write out of the hold.
 * Returns null for an unmanaged connector (the archived ones), which the hold does not govern.
 */
export function resolveOutboundConnector(connectorName: string | undefined, url: URL | null): OutboundConnector | null {
  if (url) {
    const host = normalizedHost(url)
    if (XERO_HOSTS.has(host)) return 'xero'
    if (host === 'mintsoft.co.uk' || host.endsWith('.mintsoft.co.uk')) return 'mintsoft'
  }
  return connectorFromName(connectorName)
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

function normalizedMethod(method: string | undefined | null): string {
  return (method ?? 'GET').trim().toUpperCase()
}

export function classifyOutboundRequest(params: {
  connector: OutboundConnector
  method: string | undefined | null
  url: URL | null
}): OutboundClassification {
  const method = normalizedMethod(params.method)
  const { connector, url } = params

  if (method === '' || url === null) {
    return { connector, class: 'write', basis: method === '' ? 'empty method' : 'unparseable target' }
  }

  switch (connector) {
    case 'woocommerce':
      return method === 'GET' || method === 'HEAD'
        ? { connector, class: 'read', basis: `WooCommerce ${method}` }
        : { connector, class: 'write', basis: `WooCommerce ${method}` }
    case 'xero': {
      const host = normalizedHost(url)
      if (host === 'identity.xero.com' && method === 'POST' && url.pathname === '/connect/token') {
        return { connector, class: 'read', basis: 'Xero identity token exchange (lets IMS read; changes no accounting data)' }
      }
      if ((host === 'api.xero.com' || host === 'identity.xero.com') && (method === 'GET' || method === 'HEAD')) {
        return { connector, class: 'read', basis: `Xero ${method} ${host}` }
      }
      return { connector, class: 'write', basis: `Xero ${method} ${host}${url.pathname}` }
    }
    case 'mintsoft': {
      const classification = classifyMintsoftRequest(method, url.pathname)
      return { connector, class: classification.class, basis: `Mintsoft ${classification.label}` }
    }
    default: {
      const unhandled: never = connector
      throw new Error(`unhandled outbound connector ${String(unhandled)}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Grants (environment only)
// ---------------------------------------------------------------------------------------------

export type GrantReadFailure = { ok: false; reason: 'absent' | 'unreadable'; detail: string }

export type WooCommerceGrant = { ok: true; origin: string }
export type MintsoftGrant = { ok: true; origin: string; pathPrefix: string; baseUrl: string; clientId: string }
export type XeroGrant = { ok: true; tenantId: string }

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)]$/, '$1')
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1'
}

function rawValue(env: OutboundEnv, name: string): string | null {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

function absent(name: string): GrantReadFailure {
  return { ok: false, reason: 'absent', detail: `${name} is not set` }
}

function unreadable(name: string, detail: string): GrantReadFailure {
  return { ok: false, reason: 'unreadable', detail: `${name}: ${detail}` }
}

/**
 * Parse an origin-shaped value: `https://host[:port]`, an optional single trailing slash, `http` only
 * for loopback. When `allowPath` is false any path, query, fragment, credentials, list separator or
 * whitespace makes it unreadable.
 */
function parseDestinationUrl(
  name: string,
  value: string,
  allowPath: boolean,
): { ok: true; url: URL; pathPrefix: string } | GrantReadFailure {
  if (/[\s,;]/.test(value)) {
    return unreadable(name, 'must name exactly one destination; it contains whitespace or a list separator')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return unreadable(name, 'is not an absolute URL')
  }
  if (url.username || url.password || url.hash || url.search) {
    return unreadable(name, 'must have no credentials, query or fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    return unreadable(name, 'must use https (http is accepted only for loopback)')
  }
  if (url.origin === 'null') return unreadable(name, 'has no comparable origin')
  const pathname = url.pathname.replace(/\/+$/, '')
  if (!allowPath && pathname !== '') return unreadable(name, `must be a bare origin with no path (got "${url.pathname}")`)
  if (pathname.includes('//') || /%2f/i.test(pathname)) return unreadable(name, 'has an ambiguous path')
  return { ok: true, url, pathPrefix: pathname }
}

export function readWooCommerceGrant(env: OutboundEnv = process.env): WooCommerceGrant | GrantReadFailure {
  const name = OUTBOUND_GRANT_ENV.woocommerce
  const raw = rawValue(env, name)
  if (raw === null) return absent(name)
  const parsed = parseDestinationUrl(name, raw, false)
  if (!parsed.ok) return parsed
  return { ok: true, origin: parsed.url.origin }
}

const CLIENT_ID_RE = /^[1-9][0-9]{0,9}$/

export function readMintsoftGrant(env: OutboundEnv = process.env): MintsoftGrant | GrantReadFailure {
  const name = OUTBOUND_GRANT_ENV.mintsoft
  const raw = rawValue(env, name)
  if (raw === null) return absent(name)
  const parts = raw.split('|')
  if (parts.length !== 2) {
    return unreadable(name, 'must be <base URL>|<ClientId> with exactly one vertical bar')
  }
  const [base, clientId] = parts.map((part) => part.trim()) as [string, string]
  if (!CLIENT_ID_RE.test(clientId)) return unreadable(name, 'the ClientId must be a positive integer without leading zeros')
  const parsed = parseDestinationUrl(name, base, true)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    origin: parsed.url.origin,
    pathPrefix: parsed.pathPrefix,
    baseUrl: `${parsed.url.origin}${parsed.pathPrefix}`,
    clientId,
  }
}

/**
 * A Xero tenant id is an opaque id (in practice a UUID). The shape accepted is deliberately narrow - one
 * token, no separators - and the words people put in a flag variable are refused outright, so `true`,
 * `1` or `all` can never be read as a tenant that happens to be granted.
 */
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FLAG_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'all', 'any', 'none', 'null', 'undefined', '0', '1', '*'])

export function readXeroGrant(env: OutboundEnv = process.env): XeroGrant | GrantReadFailure {
  const name = OUTBOUND_GRANT_ENV.xero
  const raw = rawValue(env, name)
  if (raw === null) return absent(name)
  if (!TENANT_ID_RE.test(raw) || FLAG_WORDS.has(raw.toLowerCase())) {
    return unreadable(name, 'must be exactly one tenant id (a UUID), not a list, a name or a flag')
  }
  return { ok: true, tenantId: raw.toLowerCase() }
}

export type OutboundGrantState =
  | { connector: OutboundConnector; state: 'held'; envName: string }
  | { connector: OutboundConnector; state: 'unreadable'; envName: string; detail: string }
  | { connector: OutboundConnector; state: 'granted'; envName: string; destination: string }

/** The state of every connector's grant, for `outbound:status`. Reads the environment only. */
export function readOutboundGrantStates(env: OutboundEnv = process.env): OutboundGrantState[] {
  const states: OutboundGrantState[] = []
  for (const connector of OUTBOUND_CONNECTORS) {
    const envName = OUTBOUND_GRANT_ENV[connector]
    if (connector === 'woocommerce') {
      const grant = readWooCommerceGrant(env)
      states.push(describe(connector, envName, grant, (g) => g.origin))
    } else if (connector === 'mintsoft') {
      const grant = readMintsoftGrant(env)
      states.push(describe(connector, envName, grant, (g) => `${g.baseUrl} (ClientId ${g.clientId})`))
    } else {
      const grant = readXeroGrant(env)
      states.push(describe(connector, envName, grant, (g) => `tenant ${g.tenantId}`))
    }
  }
  return states
}

function describe<G extends { ok: true }>(
  connector: OutboundConnector,
  envName: string,
  grant: G | GrantReadFailure,
  destination: (grant: G) => string,
): OutboundGrantState {
  if (grant.ok) return { connector, state: 'granted', envName, destination: destination(grant) }
  if (grant.reason === 'absent') return { connector, state: 'held', envName }
  return { connector, state: 'unreadable', envName, detail: grant.detail }
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

export type OutboundWriteRefusal = {
  connector: OutboundConnector
  code: OutboundWriteRefusalCode
  method: string
  /** Origin plus path of the request, query removed. Null when the target could not be parsed. */
  target: string | null
  granted: string | null
  attempted: string | null
  basis: string
}

export type OutboundRequestFacts = {
  /** The caller's connector name ('WooCommerce', 'Mintsoft', 'Xero'); other names are not governed. */
  connectorName: string | undefined
  method: string | undefined | null
  url: string | URL
  /** The request headers as they will be sent (Xero's tenant is read from `xero-tenant-id`). */
  headers?: HeadersInit | Headers
  /** The request body as it will be sent, when it is a string (Mintsoft's ClientId is checked in JSON bodies). */
  body?: unknown
  /** The ClientId Mintsoft is configured with, supplied by the Mintsoft client for every request. */
  writeScopeId?: string | number | null
  env?: OutboundEnv
}

function parseTarget(url: string | URL): URL | null {
  try {
    const parsed = url instanceof URL ? url : new URL(String(url))
    return parsed.origin === 'null' ? null : parsed
  } catch {
    return null
  }
}

function targetText(url: URL | null): string | null {
  return url ? `${url.origin}${url.pathname}` : null
}

/** Reads ClientId from the query and from a JSON body, wherever it is explicit. */
function explicitMintsoftClientIds(url: URL, body: unknown): string[] {
  const found: string[] = []
  for (const [key, value] of url.searchParams.entries()) {
    if (key.toLowerCase() === 'clientid') found.push(value.trim())
  }
  const text = typeof body === 'string' ? body.trim() : ''
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      for (const row of rows) {
        if (row && typeof row === 'object') {
          for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
            if (key.toLowerCase() === 'clientid' && (typeof value === 'string' || typeof value === 'number')) {
              found.push(String(value).trim())
            }
          }
        }
      }
    } catch {
      // A body that is not JSON carries no explicit ClientId; the configured one is still compared.
    }
  }
  return found
}

function refusal(
  classification: OutboundClassification,
  method: string,
  url: URL | null,
  code: OutboundWriteRefusalCode,
  granted: string | null,
  attempted: string | null,
): OutboundWriteRefusal {
  return {
    connector: classification.connector,
    code,
    method,
    target: targetText(url),
    granted,
    attempted,
    basis: classification.basis,
  }
}

/**
 * THE DECISION. Returns null when the request may leave, or the refusal when it may not.
 *
 * Synchronous and pure so it can be the LAST statement before the socket with nothing awaited between
 * the decision and the send.
 */
export function outboundWriteRefusal(facts: OutboundRequestFacts): OutboundWriteRefusal | null {
  const env = facts.env ?? process.env
  const url = parseTarget(facts.url)
  const connector = resolveOutboundConnector(facts.connectorName, url)
  if (connector === null) return null

  const method = normalizedMethod(facts.method)
  const classification = classifyOutboundRequest({ connector, method, url })
  if (classification.class === 'read') return null

  if (url === null) {
    // A target that cannot be parsed cannot be shown to be the granted destination - but an absent or
    // unreadable grant is the more useful thing to say when that is also true.
    const grantState = readOutboundGrantStates(env).find((state) => state.connector === connector)
    if (grantState?.state === 'held') return refusal(classification, method, url, 'no_grant', null, null)
    if (grantState?.state === 'unreadable') return refusal(classification, method, url, 'unreadable_grant', null, null)
    return refusal(classification, method, url, 'unparseable_target', grantState && grantState.state === 'granted' ? grantState.destination : null, null)
  }

  switch (connector) {
    case 'woocommerce': {
      const grant = readWooCommerceGrant(env)
      if (!grant.ok) return refusal(classification, method, url, grant.reason === 'absent' ? 'no_grant' : 'unreadable_grant', null, url.origin)
      if (url.origin !== grant.origin) return refusal(classification, method, url, 'destination_mismatch', grant.origin, url.origin)
      return null
    }
    case 'mintsoft': {
      const grant = readMintsoftGrant(env)
      if (!grant.ok) return refusal(classification, method, url, grant.reason === 'absent' ? 'no_grant' : 'unreadable_grant', null, url.origin)
      const underBase = url.origin === grant.origin
        && (grant.pathPrefix === '' || url.pathname === grant.pathPrefix || url.pathname.startsWith(`${grant.pathPrefix}/`))
      if (!underBase) return refusal(classification, method, url, 'destination_mismatch', grant.baseUrl, `${url.origin}${url.pathname}`)

      // The one Mintsoft write that has no tenant scope to speak of: the key-minting login. It is
      // governed by the base URL alone. Everything else must be provably for the granted ClientId.
      const relativePath = mintsoftRelativePath(url.pathname.slice(grant.pathPrefix.length) || '/')
      const isAuthLogin = method === 'POST' && relativePath === '/api/Auth'
      if (isAuthLogin) return null

      const configured = facts.writeScopeId === null || facts.writeScopeId === undefined
        ? ''
        : String(facts.writeScopeId).trim()
      if (configured === '') return refusal(classification, method, url, 'client_unproven', grant.clientId, null)
      if (configured !== grant.clientId) return refusal(classification, method, url, 'client_mismatch', grant.clientId, configured)
      for (const explicit of explicitMintsoftClientIds(url, facts.body)) {
        if (explicit !== grant.clientId) return refusal(classification, method, url, 'client_mismatch', grant.clientId, explicit)
      }
      return null
    }
    case 'xero': {
      const grant = readXeroGrant(env)
      if (!grant.ok) return refusal(classification, method, url, grant.reason === 'absent' ? 'no_grant' : 'unreadable_grant', null, null)
      const tenantHeader = facts.headers === undefined ? null : new Headers(facts.headers).get('xero-tenant-id')
      const tenant = tenantHeader === null ? '' : tenantHeader.trim().toLowerCase()
      if (tenant === '') return refusal(classification, method, url, 'tenant_unproven', grant.tenantId, null)
      if (tenant !== grant.tenantId) return refusal(classification, method, url, 'destination_mismatch', grant.tenantId, tenant)
      return null
    }
    default: {
      const unhandled: never = connector
      throw new Error(`unhandled outbound connector ${String(unhandled)}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The typed error
// ---------------------------------------------------------------------------------------------

/**
 * Thrown instead of connecting. TYPED so callers can tell a hold from a failure of the destination:
 * a hold is NOT a rejection by the destination and NOT a transient network fault, and nothing that
 * handles it may record it as either. `retryable` is true: the same work succeeds unchanged once the
 * destination is granted.
 */
export class OutboundWriteHeldError extends Error {
  readonly held = true as const
  readonly retryable = true as const
  readonly connector: OutboundConnector
  readonly code: OutboundWriteRefusalCode
  readonly method: string
  readonly target: string | null
  readonly granted: string | null
  readonly attempted: string | null
  readonly hop: number
  /** True only when this refusal PROVES nothing reached the destination (hop 0). */
  readonly nothingSent: boolean

  constructor(refused: OutboundWriteRefusal, hop: number) {
    super(outboundHeldMessage({
      connector: refused.connector,
      code: refused.code,
      granted: refused.granted,
      attempted: refused.attempted,
      method: refused.method,
      target: refused.target ?? '(unparseable target)',
      hop,
    }))
    this.name = 'OutboundWriteHeldError'
    this.connector = refused.connector
    this.code = refused.code
    this.method = refused.method
    this.target = refused.target
    this.granted = refused.granted
    this.attempted = refused.attempted
    this.hop = hop
    this.nothingSent = hop === 0
  }
}

/** Brand check that survives the same module being bundled twice (instanceof alone does not). */
export function isOutboundWriteHeldError(error: unknown): error is OutboundWriteHeldError {
  if (error instanceof OutboundWriteHeldError) return true
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'OutboundWriteHeldError'
    && (error as { held?: unknown }).held === true
}
