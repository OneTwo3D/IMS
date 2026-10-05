import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test, { after } from 'node:test'

import { connectorFetch } from '../../lib/security/connector-fetch.ts'
import { guardedExternalFetch } from '../../lib/security/guarded-external-fetch.ts'
import { OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'

/**
 * WHAT HOLD-REFERENCE SCRUBBING DOES TO EACH BODY TYPE THE REAL CALLERS SEND (read from the call sites):
 * JSON strings, URLSearchParams (Xero token requests) and a Uint8Array (the Xero attachment upload). Text is
 * scrubbed; a BINARY payload is never rewritten (it would corrupt it and desynchronise Content-Length);
 * every other body type is refused by connectorFetch. Local loopback listener only.
 */

type Seen = { method: string; headers: Record<string, string | string[] | undefined>; body: Buffer }
const seen: Seen[] = []
const servers: Server[] = []

async function listener(): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => { seen.push({ method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(200); res.end('{}') })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
after(async () => { await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))) })

const real = new OutboundWriteHeldError({ connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.com/x', granted: null, attempted: null, basis: 'b' }, 0).message
const TOKEN_RE = /\[hold-ref /
const env = (origin: string) => ({ E2E_TEST_MODE: '1', NODE_ENV: 'test', WC_WRITEBACK_ALLOWED_ORIGIN: origin })

test('text bodies lose the token: JSON string, URLSearchParams (before encoding), and a textual Buffer; a stale Content-Length is corrected', async () => {
  assert.match(real, TOKEN_RE, 'precondition: a real hold text carries a token (a valid SETTINGS_ENCRYPTION_KEY is set, as in CI)')
  const origin = await listener()
  seen.length = 0
  const options = { connectorName: 'WooCommerce', allowE2eLocalHttp: true, env: env(origin) }
  console.log('precondition (text bodies): a real hold text inside a JSON string, a form value and a JSON Buffer, through connectorFetch')
  await connectorFetch(`${origin}/a`, { method: 'POST', body: JSON.stringify({ note: real }) }, options)
  await connectorFetch(`${origin}/b`, { method: 'POST', body: new URLSearchParams({ note: real, keep: 'yes' }) }, options)
  const json = Buffer.from(JSON.stringify({ note: real }), 'utf8')
  await connectorFetch(`${origin}/c`, { method: 'POST', body: new Uint8Array(json), headers: { 'content-type': 'application/json', 'content-length': String(json.length) } }, options)
  assert.equal(seen.length, 3)
  for (const request of seen) {
    const wire = request.body.toString('utf8')
    assert.equal(TOKEN_RE.test(wire), false, 'no token on the wire')
    assert.equal(TOKEN_RE.test(decodeURIComponent(wire.replace(/\+/g, ' '))), false, 'nor in decoded form values')
    assert.ok(decodeURIComponent(wire.replace(/\+/g, ' ')).includes('Outbound write HELD'), 'the text itself is kept')
  }
  assert.match(decodeURIComponent(seen[1]!.body.toString().replace(/\+/g, ' ')), /keep=yes/, 'other form fields are untouched')
  assert.equal(Number(seen[2]!.headers['content-length']), seen[2]!.body.length, 'Content-Length matches the bytes actually sent')
})

test('a BINARY body (the Xero attachment shape) is never rewritten, even if it contains the token pattern, and keeps its Content-Length', async () => {
  const origin = await listener()
  seen.length = 0
  const binary = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00]), Buffer.from(' [hold-ref 0123456789abcdef01]'), Buffer.from([0x80, 0x81, 0xc3, 0x28])])
  console.log(`precondition (binary): ${binary.length}-byte PDF-like payload with invalid UTF-8 and the token pattern inside`)
  await connectorFetch(`${origin}/upload`, {
    method: 'POST', body: new Uint8Array(binary),
    headers: { 'content-type': 'application/pdf', 'content-length': String(binary.length) },
  }, { connectorName: 'WooCommerce', allowE2eLocalHttp: true, env: env(origin) })
  await guardedExternalFetch(`${origin}/upload`, { method: 'POST', body: new Uint8Array(binary), headers: { 'content-type': 'application/pdf' } }, { connectorName: 'WooCommerce', env: env(origin) })
  assert.equal(seen.length, 2)
  for (const request of seen) {
    assert.deepEqual(request.body, binary, 'byte for byte identical')
    assert.equal(Number(request.headers['content-length']), binary.length)
  }
})

test('body types connectorFetch cannot inspect are refused before anything is sent', async () => {
  const origin = await listener()
  seen.length = 0
  const options = { connectorName: 'WooCommerce', allowE2eLocalHttp: true, env: env(origin) }
  const unsupported: Array<[string, BodyInit]> = [
    ['FormData', new FormData()],
    ['Blob', new Blob(['x'])],
    ['ReadableStream', new ReadableStream()],
  ]
  console.log(`precondition (unsupported): ${unsupported.length} body types on a granted WRITE`)
  for (const [name, body] of unsupported) {
    await assert.rejects(connectorFetch(`${origin}/x`, { method: 'POST', body }, options), /not supported/, name)
  }
  assert.equal(seen.length, 0)
})
