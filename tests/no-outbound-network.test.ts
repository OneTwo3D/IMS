import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'

/**
 * tests/no-outbound-network.ts, PROVEN ABLE TO FIRE (o3d-bhvu round 2).
 *
 * The trap is only worth having if it is loaded and actually refuses: so this asserts it is installed in
 * this very process, that a connection to a routable address is refused with the trap's own error (not a
 * timeout, which a slow network would also produce), that the real connectorFetch pointed at the live
 * Mintsoft host is refused, that loopback still works, and that both test scripts load it.
 */

test('the trap is installed in this test process', () => {
  assert.equal((globalThis as unknown as Record<symbol, unknown>)[Symbol.for('ims.tests.noOutboundNetwork')], true,
    'run through npm run test:unit / test:concurrency, which --import tests/no-outbound-network.ts')
})

test('a raw TCP connection to a routable address is refused by the trap, before anything is sent', async () => {
  const error = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: '192.0.2.10', port: 443 })
    socket.on('connect', () => resolve(new Error('connected — the trap did not fire')))
    socket.on('error', resolve)
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
  assert.match(error.message, /192\.0\.2\.10:443/)
})

test('a remote NAME is refused once it resolves, and a caller\u2019s own lookup error still surfaces as itself', async () => {
  const error = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: 'remote.example.test', port: 443, lookup: (_host, _options, callback) => (callback as (e: null, a: string, f: number) => void)(null, '198.51.100.7', 4) })
    socket.on('connect', () => resolve(new Error('connected — the trap did not fire')))
    socket.on('error', resolve)
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
  assert.match(error.message, /198\.51\.100\.7/)
  const own = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: 'refused.example.test', port: 443, lookup: (_host, _options, callback) => (callback as (e: Error) => void)(new Error('the caller refused this name itself')) })
    socket.on('error', resolve)
  })
  assert.equal(own.message, 'the caller refused this name itself', 'the caller\u2019s own refusal is not masked by the trap')
  const local = await new Promise<string>((resolve) => {
    const socket = net.connect({ host: 'loopback.example.test', port: 1, lookup: (_host, _options, callback) => (callback as (e: null, a: string, f: number) => void)(null, '127.0.0.1', 4) })
    socket.on('error', (error: Error) => resolve(error.name === 'OutboundNetworkBlockedError' ? 'blocked' : 'passed the trap'))
    socket.on('connect', () => { socket.destroy(); resolve('passed the trap') })
  })
  assert.equal(local, 'passed the trap', 'a name that resolves to loopback is let through (port 1 then refuses the connection itself)')
})

test('an http request to a remote host is refused by the trap', async () => {
  const error = await new Promise<Error>((resolve) => {
    const req = httpRequest({ host: '192.0.2.11', port: 80, path: '/' }, () => resolve(new Error('got a response')))
    req.on('error', resolve)
    req.end()
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
})

test('connectorFetch against the LIVE Mintsoft host is refused by the trap, not sent', async () => {
  const { connectorFetch } = await import('@/lib/security/connector-fetch')
  await assert.rejects(
    // The live Mintsoft host, resolved through connectorFetch's own injectable lookup to a public address
    // (TEST-NET-3), so the proof needs no DNS: connectorFetch's SSRF check passes it, the trap refuses it.
    connectorFetch('https://api.mintsoft.co.uk/api/Warehouse', { method: 'GET' }, {
      connectorName: 'Mintsoft',
      lookup: async () => [{ address: '203.0.113.20', family: 4 }],
    }),
    (error: unknown) => error instanceof Error && /Blocked outbound network connection|OutboundNetworkBlocked/.test(`${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`),
  )
})

test('loopback connections still work, so local test servers and the scratch database are unaffected', async () => {
  const server = createServer((_request, response) => { response.end('ok') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as net.AddressInfo).port
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(body, 'ok')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('both test scripts load the trap', () => {
  const scripts = (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  for (const name of ['test:unit', 'test:concurrency']) {
    assert.match(scripts[name] ?? '', /--import\s+\.\/tests\/no-outbound-network\.ts/, `${name} must --import the trap`)
  }
})
