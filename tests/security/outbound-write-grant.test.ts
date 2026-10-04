import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyOutboundRequest,
  outboundWriteRefusal,
  readMintsoftGrant,
  readOutboundGrantStates,
  readWooCommerceGrant,
  readXeroGrant,
  resolveOutboundConnector,
} from '../../lib/security/outbound-write-grant.ts'
import { OUTBOUND_CONNECTORS, OUTBOUND_GRANT_ENV } from '../../lib/security/outbound-write-hold-constants.ts'

/** The DECISION in isolation from any HTTP. The wire is proven in outbound-write-hold-transport.test.ts. */

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'

test('classification table: WooCommerce by method, Xero by host and method, Mintsoft by path', () => {
  const u = (s: string) => new URL(s)
  const rows: Array<[string, 'woocommerce' | 'mintsoft' | 'xero', string, string, 'read' | 'write']> = [
    ['WC GET', 'woocommerce', 'GET', 'https://shop.example.com/wp-json/wc/v3/orders', 'read'],
    ['WC HEAD', 'woocommerce', 'HEAD', 'https://shop.example.com/wp-json/wc/v3/orders', 'read'],
    ['WC no method (fetch default)', 'woocommerce', '', 'https://shop.example.com/x', 'write'],
    ['WC POST', 'woocommerce', 'POST', 'https://shop.example.com/wp-json/wc/v3/webhooks', 'write'],
    ['WC PUT', 'woocommerce', 'PUT', 'https://shop.example.com/wp-json/wc/v3/orders/1', 'write'],
    ['WC PATCH', 'woocommerce', 'patch', 'https://shop.example.com/x', 'write'],
    ['WC DELETE', 'woocommerce', 'DELETE', 'https://shop.example.com/x', 'write'],
    ['WC OPTIONS', 'woocommerce', 'OPTIONS', 'https://shop.example.com/x', 'write'],
    ['Xero GET api', 'xero', 'GET', 'https://api.xero.com/api.xro/2.0/Invoices', 'read'],
    ['Xero GET connections', 'xero', 'GET', 'https://api.xero.com/connections', 'read'],
    ['Xero token exchange', 'xero', 'POST', 'https://identity.xero.com/connect/token', 'read'],
    ['Xero POST api', 'xero', 'POST', 'https://api.xero.com/api.xro/2.0/Invoices', 'write'],
    ['Xero PUT api', 'xero', 'PUT', 'https://api.xero.com/api.xro/2.0/Contacts', 'write'],
    ['Xero DELETE connections', 'xero', 'DELETE', 'https://api.xero.com/connections/abc', 'write'],
    ['Xero POST other identity path', 'xero', 'POST', 'https://identity.xero.com/connect/revocation', 'write'],
    ['Xero token path on the wrong host', 'xero', 'POST', 'https://example.com/connect/token', 'write'],
    ['Xero GET on a host that is not Xero', 'xero', 'GET', 'https://example.com/api.xro/2.0/Invoices', 'write'],
    ['Mintsoft GET read', 'mintsoft', 'GET', 'https://api.mintsoft.co.uk/api/Order/Search?OrderNumber=1', 'read'],
    ['Mintsoft GET /Cancel', 'mintsoft', 'GET', 'https://api.mintsoft.co.uk/api/Order/5/Cancel', 'write'],
    ['Mintsoft POST /Auth', 'mintsoft', 'POST', 'https://api.mintsoft.co.uk/api/Auth', 'write'],
    ['Mintsoft PUT /Order', 'mintsoft', 'PUT', 'https://api.mintsoft.co.uk/api/Order', 'write'],
  ]
  for (const [name, connector, method, url, expected] of rows) {
    assert.equal(classifyOutboundRequest({ connector, method, url: u(url) }).class, expected, name)
  }
  console.log(`precondition (classification): ${rows.length} rows asserted`)
})

test('a request to a known vendor host is governed as that vendor whatever the caller called itself', () => {
  const cases: Array<[string | undefined, string, string | null]> = [
    ['WooCommerce', 'https://api.xero.com/api.xro/2.0/Invoices', 'xero'],
    [undefined, 'https://identity.xero.com/connect/token', 'xero'],
    ['Example', 'https://api.mintsoft.co.uk/api/Order', 'mintsoft'],
    ['x', 'https://eu.mintsoft.co.uk/api/Order', 'mintsoft'],
    ['WooCommerce', 'https://shop.example.com/', 'woocommerce'],
    ['Mintsoft', 'https://shop.example.com/', 'mintsoft'],
    ['QuickBooks', 'https://quickbooks.api.intuit.com/', null],
    ['Example', 'https://example.test/', null],
    ['woocommerce', 'https://shop.example.com/', 'woocommerce'],
  ]
  for (const [name, url, expected] of cases) {
    assert.equal(resolveOutboundConnector(name, new URL(url)), expected, `${name} ${url}`)
  }
  // The mislabelled write is refused: a Xero write that calls itself WooCommerce.
  const refusal = outboundWriteRefusal({
    connectorName: 'WooCommerce', method: 'POST', url: 'https://api.xero.com/api.xro/2.0/Invoices', env: {},
  })
  assert.equal(refusal?.connector, 'xero')
  assert.equal(refusal?.code, 'no_grant')
  // An unmanaged connector is not governed.
  assert.equal(outboundWriteRefusal({ connectorName: 'QuickBooks', method: 'POST', url: 'https://example.test/', env: {} }), null)
})

test('grant parsing: one readable shape each, everything else is absent or unreadable', () => {
  assert.deepEqual(readWooCommerceGrant({}), { ok: false, reason: 'absent', detail: 'WC_WRITEBACK_ALLOWED_ORIGIN is not set' })
  assert.equal(readWooCommerceGrant({ WC_WRITEBACK_ALLOWED_ORIGIN: '   ' }).ok, false)
  for (const value of ['https://shop.example.com', 'https://shop.example.com/', 'https://shop.example.com:443', 'http://127.0.0.1:8080', 'http://localhost:3000']) {
    assert.equal(readWooCommerceGrant({ WC_WRITEBACK_ALLOWED_ORIGIN: value }).ok, true, value)
  }
  for (const value of ['shop.example.com', 'https://a.example.com,https://b.example.com', 'https://a.example.com https://b.example.com', 'https://shop.example.com/wp-json', 'https://shop.example.com?x=1', 'https://shop.example.com#f', 'https://u:p@shop.example.com', 'http://shop.example.com', 'ftp://shop.example.com', 'true', '1', '*']) {
    const grant = readWooCommerceGrant({ WC_WRITEBACK_ALLOWED_ORIGIN: value })
    assert.equal(grant.ok, false, value)
    assert.equal(!grant.ok && grant.reason, 'unreadable', value)
  }
  assert.equal(readMintsoftGrant({ MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.co.uk|89' }).ok, true)
  assert.equal(readMintsoftGrant({ MINTSOFT_WRITE_ALLOWED: ' https://api.mintsoft.co.uk/ | 89 ' }).ok, true)
  for (const value of ['https://api.mintsoft.co.uk', 'https://api.mintsoft.co.uk|', 'https://api.mintsoft.co.uk|0', 'https://api.mintsoft.co.uk|089', 'https://api.mintsoft.co.uk|8 9', 'https://api.mintsoft.co.uk|89|90', 'https://a.example|89,https://b.example|90', 'https://api.mintsoft.co.uk//x|89', 'http://api.mintsoft.co.uk|89']) {
    assert.equal(readMintsoftGrant({ MINTSOFT_WRITE_ALLOWED: value }).ok, false, value)
  }
  assert.equal(readXeroGrant({ XERO_WRITE_ALLOWED_TENANT: TENANT }).ok, true)
  for (const value of [`${TENANT},${TENANT}`, `${TENANT} x`, 'true', 'FALSE', '1', '0', '*', 'all', 'Demo Company (UK)', '']) {
    assert.equal(readXeroGrant({ XERO_WRITE_ALLOWED_TENANT: value }).ok, false, value)
  }
})

test('one grant is no grant for another connector; a grant names a destination, so a different one is refused', () => {
  const env = { WC_WRITEBACK_ALLOWED_ORIGIN: 'https://stage.example.com' }
  assert.equal(outboundWriteRefusal({ connectorName: 'WooCommerce', method: 'PUT', url: 'https://stage.example.com/wp-json/wc/v3/orders/1', env }), null)
  for (const [target, why] of [
    ['http://stage.example.com/x', 'scheme'], ['https://stage.example.com:8443/x', 'port'], ['https://stage.example.co/x', 'host'], ['https://sub.stage.example.com/x', 'subdomain'], ['https://live.example.com/x', 'live store'],
  ] as const) {
    const refusal = outboundWriteRefusal({ connectorName: 'WooCommerce', method: 'PUT', url: target, env })
    assert.equal(refusal?.code, 'destination_mismatch', why)
    assert.equal(refusal?.granted, 'https://stage.example.com')
  }
  // The Xero and Mintsoft writes are not unlocked by the WooCommerce grant.
  assert.equal(outboundWriteRefusal({ connectorName: 'Xero', method: 'POST', url: 'https://api.xero.com/x', headers: { 'xero-tenant-id': TENANT }, env })?.code, 'no_grant')
  assert.equal(outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'PUT', url: 'https://api.mintsoft.co.uk/api/Order', mintsoftClientId: '89', env })?.code, 'no_grant')
})

test('Mintsoft grant covers a base path (the local fake) and refuses a sibling path', () => {
  const env = { MINTSOFT_WRITE_ALLOWED: 'http://127.0.0.1:3100/api/e2e/mintsoft|89' }
  assert.equal(outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'PUT', url: 'http://127.0.0.1:3100/api/e2e/mintsoft/api/Order', mintsoftClientId: '89', env }), null)
  assert.equal(outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'PUT', url: 'http://127.0.0.1:3100/api/Order', mintsoftClientId: '89', env })?.code, 'destination_mismatch')
  assert.equal(outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'PUT', url: 'http://127.0.0.1:3100/api/e2e/mintsoft-evil/api/Order', mintsoftClientId: '89', env })?.code, 'destination_mismatch')
})

test('outbound:status grant states come from the environment only and cover every connector', () => {
  const states = readOutboundGrantStates({ MINTSOFT_WRITE_ALLOWED: 'garbage', XERO_WRITE_ALLOWED_TENANT: TENANT })
  assert.deepEqual(states.map((s) => s.connector), [...OUTBOUND_CONNECTORS])
  assert.deepEqual(states.map((s) => s.state), ['held', 'unreadable', 'granted'])
  assert.deepEqual(states.map((s) => s.envName), OUTBOUND_CONNECTORS.map((c) => OUTBOUND_GRANT_ENV[c]))
})
