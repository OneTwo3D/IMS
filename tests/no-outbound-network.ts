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
 * (`localhost`, 127.0.0.0/8, ::1, ::ffff:127.x) proceeds; anything else is destroyed with an error that
 * names the host and port, before a single byte leaves. Local test servers, the scratch database and
 * the real-postgres-cluster harness are all loopback or Unix-socket and are unaffected.
 *
 * WHAT IT DOES NOT COVER, plainly: UDP (DNS lookups still resolve — a lookup sends a name, not our data),
 * raw `dgram`, and any test run that does not go through the two npm scripts. tests/no-outbound-network.test.ts
 * proves the trap fires for a remote address and for connectorFetch against the live Mintsoft host, lets
 * loopback through, and is wired into both scripts.
 */
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

const registry = globalThis as unknown as Record<symbol, unknown>
if (!registry[TRAP]) {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function trappedConnect(this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args)
    if (!target.path && !isLoopbackHost(target.host)) {
      const error = new Error(
        `Blocked outbound network connection to ${target.host}:${target.port} from a test process `
        + '(tests/no-outbound-network.ts). Unit and concurrency tests must stub the HTTP boundary; '
        + 'several integrations this repository calls are LIVE.',
      )
      error.name = 'OutboundNetworkBlockedError'
      process.nextTick(() => this.destroy(error))
      return this
    }
    return original.apply(this, args as Parameters<typeof original>)
  } as typeof net.Socket.prototype.connect
  registry[TRAP] = true
}
