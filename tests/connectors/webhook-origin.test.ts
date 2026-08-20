import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WEBHOOK_ORIGIN_NOT_APPLICABLE,
  WEBHOOK_ORIGIN_NOT_STATED,
  WEBHOOK_ORIGIN_PRE_ATTESTATION,
  attestWebhookOrigin,
  attestedOriginHost,
  judgeWebhookOrigin,
  normaliseOriginHost,
} from '@/lib/connectors/webhook-origin'
import { readWcDeliveryOrigin } from '@/lib/connectors/woocommerce/webhook-origin'

/**
 * o3d-wgl6: the encoding and comparison rules that decide whether a stored delivery came from
 * the store this installation is bound to.
 *
 * The comparison is between two values written by different hands — WordPress's `home_url()`
 * on one side, whatever an operator typed into Settings on the other — so most of what is
 * pinned here is the set of differences that must NOT read as a different store. Every one of
 * those would otherwise refuse real deliveries on an installation that works perfectly.
 */

test('the three unproven markers are distinct values, so a row always says which era wrote it', () => {
  const markers = [WEBHOOK_ORIGIN_PRE_ATTESTATION, WEBHOOK_ORIGIN_NOT_STATED, WEBHOOK_ORIGIN_NOT_APPLICABLE]
  assert.equal(new Set(markers).size, 3)
  // A marker must never be mistakable for a proven origin.
  for (const marker of markers) assert.equal(attestedOriginHost(marker), null)
})

test('differences that are the same store do not read as a different store', () => {
  const same = [
    'https://shop.example.com',
    'http://shop.example.com',
    'https://shop.example.com/',
    'https://SHOP.Example.COM',
    'https://shop.example.com./',
    'https://www.shop.example.com/',
    'https://shop.example.com:8443/wp/',
    'https://shop.example.com/product/widget/',
  ]
  for (const url of same) {
    assert.equal(normaliseOriginHost(url), 'shop.example.com', url)
  }
})

test('a genuinely different host is a different store', () => {
  assert.equal(normaliseOriginHost('https://other.example.com'), 'other.example.com')
  assert.notEqual(normaliseOriginHost('https://shop.example.net'), normaliseOriginHost('https://shop.example.com'))
  // `www.` is stripped, not treated as a wildcard: it must not collapse a real subdomain.
  assert.equal(normaliseOriginHost('https://wwwshop.example.com'), 'wwwshop.example.com')
})

test('anything that is not an absolute http(s) URL cannot attest an origin', () => {
  for (const raw of [null, undefined, '', '   ', 'shop.example.com', 'ftp://shop.example.com', 'javascript:alert(1)']) {
    assert.equal(normaliseOriginHost(raw as string | null), null, String(raw))
    assert.equal(attestWebhookOrigin(raw as string | null), WEBHOOK_ORIGIN_NOT_STATED, String(raw))
  }
})

test('a proven origin round-trips through the stored encoding', () => {
  const attestation = attestWebhookOrigin('https://www.Shop.Example.com/')
  assert.equal(attestation, 'store:shop.example.com')
  assert.equal(attestedOriginHost(attestation), 'shop.example.com')
})

test('the verdicts separate "the delivery proved nothing" from "our own binding is unreadable"', () => {
  assert.equal(judgeWebhookOrigin('store:shop.example.com', 'https://shop.example.com').verdict, 'same-store')
  assert.equal(judgeWebhookOrigin('store:shop.example.com', 'https://other.example.com').verdict, 'foreign-store')
  // A fact about the DELIVERY that no waiting can improve.
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_PRE_ATTESTATION, 'https://shop.example.com').verdict, 'unproven')
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_NOT_STATED, 'https://shop.example.com').verdict, 'unproven')
  // A fact about US, which an operator repairs — and which must not be answered the same way.
  assert.equal(judgeWebhookOrigin('store:shop.example.com', null).verdict, 'binding-unreadable')
  assert.equal(judgeWebhookOrigin('store:shop.example.com', 'not-a-url').verdict, 'binding-unreadable')
})

test('an unproven delivery stays unproven even when our binding is also unreadable', () => {
  // Order matters: reporting 'binding-unreadable' here would let a delivery that named no
  // store take the lenient path meant for a temporary misconfiguration.
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_PRE_ATTESTATION, null).verdict, 'unproven')
})

function wcRequest(headers: Record<string, string>) {
  return new Request('https://ims.example.com/api/webhooks/woocommerce/products', { method: 'POST', headers })
}

test('a WooCommerce delivery is read from the source header first', () => {
  const origin = readWcDeliveryOrigin(
    wcRequest({ 'x-wc-webhook-source': 'https://shop.example.com/' }),
    { permalink: 'https://elsewhere.example.com/product/widget/' },
  )
  assert.equal(origin, 'store:shop.example.com')
})

test('with no usable header, the signed body answers instead', () => {
  assert.equal(
    readWcDeliveryOrigin(wcRequest({}), { permalink: 'https://shop.example.com/product/widget/' }),
    'store:shop.example.com',
  )
  assert.equal(
    readWcDeliveryOrigin(wcRequest({ 'x-wc-webhook-source': '' }), {
      _links: { self: [{ href: 'https://shop.example.com/wp-json/wc/v3/products/42' }] },
    }),
    'store:shop.example.com',
  )
})

test('a delivery with nothing to go on says so positively', () => {
  for (const payload of [null, undefined, 'a string', 42, {}, { permalink: '   ' }, { _links: { self: [] } }]) {
    assert.equal(readWcDeliveryOrigin(wcRequest({}), payload), WEBHOOK_ORIGIN_NOT_STATED, JSON.stringify(payload))
  }
})
