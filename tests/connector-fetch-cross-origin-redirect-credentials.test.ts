import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import test from 'node:test'

/**
 * Cross-origin redirects must not carry vendor credential headers (Mintsoft's ms-apikey) nor replay a request body (the auth POST on 307/308).
 * Real transport, local loopback listeners only.
 * Named mutations: ms-apikey removed from CROSS_ORIGIN_CREDENTIAL_HEADERS; body guard removed.
 */
async function listen(handler: (url: string, headers: IncomingHttpHeaders, method: string) => { status: number; location?: string }) {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; method: string }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers, method: req.method ?? '' })
    const out = handler(req.url ?? '', req.headers, req.method ?? '')
    res.writeHead(out.status, out.location ? { Location: out.location } : {})
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

const opts = { connectorName: 'TestConnector', allowE2eLocalHttp: true }

test('cross-origin 302: ms-apikey and other credential headers are stripped; same-origin keeps them', async () => {
  process.env.E2E_TEST_MODE = '1'
  const other = await listen(() => ({ status: 200 }))
  const first = await listen((url) => (url === '/x' ? { status: 302, location: `${other.base}/y` } : url === '/same' ? { status: 302, location: '/z' } : { status: 200 }))
  try {
    const { connectorFetch } = await import('../lib/security/connector-fetch.ts')
    const headers = { 'ms-apikey': 'SECRET', 'x-api-key': 'SECRET2', authorization: 'Bearer t' }
    await connectorFetch(`${first.base}/x`, { method: 'GET', headers }, opts)
    assert.equal(other.seen.length, 1)
    assert.equal(other.seen[0].headers['ms-apikey'], undefined)
    assert.equal(other.seen[0].headers['x-api-key'], undefined)
    assert.equal(other.seen[0].headers.authorization, undefined)

    await connectorFetch(`${first.base}/same`, { method: 'GET', headers }, opts)
    const sameHop = first.seen.find((s) => s.url === '/z')
    assert.equal(sameHop?.headers['ms-apikey'], 'SECRET')
  } finally {
    first.server.close(); other.server.close()
  }
})

test('cross-origin 307 with a body is refused and the body is never sent to the other origin', async () => {
  process.env.E2E_TEST_MODE = '1'
  const other = await listen(() => ({ status: 200 }))
  const first = await listen(() => ({ status: 307, location: `${other.base}/api/Auth` }))
  try {
    const { connectorFetch } = await import('../lib/security/connector-fetch.ts')
    await assert.rejects(
      connectorFetch(`${first.base}/api/Auth`, { method: 'POST', body: JSON.stringify({ Username: 'u', Password: 'p' }) }, opts),
      /cross-origin redirect/,
    )
    assert.equal(other.seen.length, 0)
  } finally {
    first.server.close(); other.server.close()
  }
})
