/**
 * NO UNIT TEST MAY OPEN A NETWORK CONNECTION TO ANYTHING BUT THIS MACHINE (o3d-bhvu round 2).
 *
 * WHY. Several integrations this repository talks to are LIVE: Mintsoft (ClientId 89) fulfils whatever it
 * is sent, and the review of o3d-bhvu found a unit test that, after a merge, drove an ASN creator with the
 * real Mintsoft list reader unstubbed and `@/lib/security/connector-fetch` unmocked. With working database
 * credentials and stored Mintsoft settings that test would have issued GETs to the live tenant. A mock
 * that a test forgets is silent; this is not.
 *
 * WHAT. Loaded with `--import` by `npm run test:unit` and `npm run test:concurrency` (Node's test runner
 * passes it to every per-file child), it wraps `net.Socket.prototype.connect` — the one place every TCP
 * and TLS client in Node ends up: `http`/`https` requests (which is what `connectorFetch` uses), `fetch`
 * (undici), `tls.connect`, and database drivers alike. A connection to a Unix socket or a loopback address
 * (`localhost`, 127.0.0.0/8, ::1, ::ffff:127.x) proceeds; a non-loopback IP is refused outright; a NAME is
 * resolved first — through the caller's own lookup where it has one, so connectorFetch's SSRF refusals
 * still surface as themselves — and refused if it resolves to anything that is not loopback. The refusal
 * is an `OutboundNetworkBlockedError` naming the host and port, raised before the socket connects. Local test servers, the scratch database and
 * the real-postgres-cluster harness are all loopback or Unix-socket and are unaffected.
 *
 * WHAT IT DOES NOT COVER, plainly: UDP (DNS lookups still resolve — a lookup sends a name, not our data),
 * raw `dgram`, and any test run that does not go through the two npm scripts. tests/no-outbound-network.test.ts
 * proves the trap fires for a remote address and for connectorFetch against the live Mintsoft host, lets
 * loopback through, and is wired into both scripts.
 */
import dns from 'node:dns'
import net from 'node:net'

const TRAP = Symbol.for('ims.tests.noOutboundNetwork')

type ConnectTarget = { host?: string; port?: number | string; path?: string }

function targetOf(args: unknown[]): ConnectTarget {
  const first = args[0]
  if (Array.isArray(first)) return targetOf(first) // net's internal normalized [options, cb] form
  if (first && typeof first === 'object') return first as ConnectTarget
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first }
  return { port: first as number | string, host: typeof args[1] === 'string' ? args[1] : undefined }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host == null || host === '') return true // Node defaults an omitted host to localhost
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  return false
}

type LookupCallback = (error: Error | null, address?: unknown, family?: number) => void
type LookupFunction = (hostname: string, options: unknown, callback: LookupCallback) => void

function blockedError(host: string | undefined, port: number | string | undefined, resolved?: string): Error {
  const error = new Error(
    `Blocked outbound network connection to ${host}:${port}${resolved ? ` (resolved to ${resolved})` : ''} `
    + 'from a test process (tests/no-outbound-network.ts). Unit and concurrency tests must stub the HTTP '
    + 'boundary; several integrations this repository calls are LIVE.',
  )
  error.name = 'OutboundNetworkBlockedError'
  return error
}

function isIpLiteral(host: string): boolean {
  return net.isIP(host.replace(/^\[|\]$/g, '')) !== 0
}

/**
 * A HOSTNAME IS DECIDED AFTER IT RESOLVES, NOT BEFORE. Some callers resolve through their own `lookup`
 * and refuse addresses there — connectorFetch's SSRF guard rejects private and metadata addresses inside
 * its lookup, and its tests assert on that rejection. So the name's own lookup (the caller's, or DNS)
 * runs first and its error, if any, passes through unchanged; only an address it RESOLVES TO that is not
 * loopback is refused here, before the socket connects to it.
 */
function guardedLookup(original: LookupFunction | undefined, host: string, port: number | string | undefined): LookupFunction {
  const resolve: LookupFunction = original ?? ((hostname, options, callback) => {
    dns.lookup(hostname, (options ?? {}) as dns.LookupAllOptions, callback as never)
  })
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family)
      const addresses = Array.isArray(address)
        ? (address as Array<{ address: string }>).map((entry) => entry.address)
        : [String(address)]
      const remote = addresses.find((entry) => !isLoopbackHost(entry))
      if (remote) return callback(blockedError(host, port, remote))
      return callback(null, address, family)
    })
  }
}

const registry = globalThis as unknown as Record<symbol, unknown>
if (!registry[TRAP]) {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function trappedConnect(this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args)
    if (target.path || isLoopbackHost(target.host)) {
      return original.apply(this, args as Parameters<typeof original>)
    }
    if (target.host && isIpLiteral(target.host)) {
      const error = blockedError(target.host, target.port)
      process.nextTick(() => this.destroy(error))
      return this
    }
    // A name: let it resolve, then refuse any non-loopback address it resolves to.
    const options = { ...(target as Record<string, unknown>) }
    options.lookup = guardedLookup(options.lookup as LookupFunction | undefined, String(target.host), target.port)
    if (Array.isArray(args[0])) {
      // net's internal normalized form carries a private marker symbol on the ARRAY; replace the options
      // in place so the marker survives and the call is not re-normalized.
      ;(args[0] as unknown[])[0] = options
      return original.apply(this, args as Parameters<typeof original>)
    }
    const callback = args.find((arg) => typeof arg === 'function')
    return original.apply(this, (callback ? [options, callback] : [options]) as Parameters<typeof original>)
  } as typeof net.Socket.prototype.connect
  registry[TRAP] = true
}
