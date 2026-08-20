import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WEBHOOK_ORIGIN_LEGACY_WRITER,
  WEBHOOK_ORIGIN_NOT_APPLICABLE,
  WEBHOOK_ORIGIN_NOT_STATED,
  WEBHOOK_ORIGIN_PRE_ATTESTATION,
  attestWebhookOrigin,
  attestWebhookOriginUnder,
  attestedOrigin,
  judgeWebhookOrigin,
  normaliseStoreIdentity,
} from '@/lib/connectors/webhook-origin'
import { readWcDeliveryOrigin } from '@/lib/connectors/woocommerce/webhook-origin'

/**
 * o3d-wgl6: the encoding and comparison rules that decide whether a stored delivery came from
 * the store this installation is bound to.
 *
 * The comparison is between two values written by different hands — WordPress's `home_url()`
 * on one side, whatever an operator typed into Settings on the other — so much of what is
 * pinned here is the set of differences that must NOT read as a different store. Every one of
 * those would otherwise refuse real deliveries on an installation that works perfectly.
 *
 * The path is the exception, and it is pinned in the opposite direction: it is the only thing
 * that tells two path-based multisite stores on one host apart.
 */

test('the four unproven markers are distinct values, so a row always says which era wrote it', () => {
  const markers = [
    WEBHOOK_ORIGIN_PRE_ATTESTATION,
    WEBHOOK_ORIGIN_NOT_STATED,
    WEBHOOK_ORIGIN_NOT_APPLICABLE,
    WEBHOOK_ORIGIN_LEGACY_WRITER,
  ]
  assert.equal(new Set(markers).size, 4)
  // A marker must never be mistakable for a proven origin.
  for (const marker of markers) assert.equal(attestedOrigin(marker), null)
})

test('differences that are the same store do not read as a different store', () => {
  const same = [
    'https://shop.example.com',
    'http://shop.example.com',
    'https://shop.example.com/',
    'https://SHOP.Example.COM',
    'https://shop.example.com./',
    'https://www.shop.example.com/',
    'https://shop.example.com:8443/',
    'https://shop.example.com//',
  ]
  for (const url of same) {
    assert.equal(normaliseStoreIdentity(url), 'shop.example.com', url)
  }
})

test('a genuinely different host is a different store', () => {
  assert.equal(normaliseStoreIdentity('https://other.example.com'), 'other.example.com')
  assert.notEqual(normaliseStoreIdentity('https://shop.example.net'), normaliseStoreIdentity('https://shop.example.com'))
  // `www.` is stripped, not treated as a wildcard: it must not collapse a real subdomain.
  assert.equal(normaliseStoreIdentity('https://wwwshop.example.com'), 'wwwshop.example.com')
})

/**
 * FINDING 2. Round 2 compared the hostname alone, so both of these attested as
 * `store:shop.example.com` and a delivery from either was accepted while bound to the other.
 * Path-based WordPress multisite is exactly this shape: separate products, separate keys,
 * separate webhooks, one host.
 */
test('two stores in subdirectories of one host do not attest identically', () => {
  const storeA = attestWebhookOrigin('https://shop.example.com/store-a/')
  const storeB = attestWebhookOrigin('https://shop.example.com/store-b/')

  assert.equal(storeA, 'store:shop.example.com/store-a')
  assert.equal(storeB, 'store:shop.example.com/store-b')
  assert.notEqual(storeA, storeB)

  assert.equal(judgeWebhookOrigin(storeA, 'https://shop.example.com/store-a').verdict, 'same-store')
  assert.equal(judgeWebhookOrigin(storeA, 'https://shop.example.com/store-b').verdict, 'foreign-store')
  // The root site of the same network is a third store, not either subsite.
  assert.equal(judgeWebhookOrigin(storeA, 'https://shop.example.com').verdict, 'foreign-store')
  assert.equal(judgeWebhookOrigin(attestWebhookOrigin('https://shop.example.com/'), 'https://shop.example.com/store-a').verdict, 'foreign-store')
})

test('a subdirectory store still tolerates the differences a root store does', () => {
  const attestation = attestWebhookOrigin('https://www.SHOP.example.com:8443/Store-B/')
  assert.equal(judgeWebhookOrigin(attestation, 'http://shop.example.com/store-b').verdict, 'same-store')
})

test('anything that is not an absolute http(s) URL cannot attest an origin', () => {
  for (const raw of [null, undefined, '', '   ', 'shop.example.com', 'ftp://shop.example.com', 'javascript:alert(1)']) {
    assert.equal(normaliseStoreIdentity(raw as string | null), null, String(raw))
    assert.equal(attestWebhookOrigin(raw as string | null), WEBHOOK_ORIGIN_NOT_STATED, String(raw))
    assert.equal(attestWebhookOriginUnder(raw as string | null), WEBHOOK_ORIGIN_NOT_STATED, String(raw))
  }
})

test('a proven origin round-trips through the stored encoding', () => {
  const attestation = attestWebhookOrigin('https://www.Shop.Example.com/')
  assert.equal(attestation, 'store:shop.example.com')
  assert.deepEqual(attestedOrigin(attestation), { identity: 'shop.example.com', scope: 'exact' })
})

/**
 * A resource URL cannot be reduced to a site root — `shop.example.com/store-b/product/widget`
 * is either the `/store-b` subsite's widget or the root site's product at a path beginning
 * `store-b` — so it is stored as a containment statement and compared as one.
 */
test('a resource URL proves containment, not the site root', () => {
  const attestation = attestWebhookOriginUnder('https://shop.example.com/store-b/product/widget/')
  assert.equal(attestation, 'store-under:shop.example.com/store-b/product/widget')
  assert.deepEqual(attestedOrigin(attestation), {
    identity: 'shop.example.com/store-b/product/widget',
    scope: 'under',
  })

  assert.equal(judgeWebhookOrigin(attestation, 'https://shop.example.com/store-b').verdict, 'same-store')
  assert.equal(judgeWebhookOrigin(attestation, 'https://shop.example.com/store-a').verdict, 'foreign-store')
  assert.equal(judgeWebhookOrigin(attestation, 'https://other.example.com/store-b').verdict, 'foreign-store')
})

test('containment is compared on a segment boundary, not as a bare string prefix', () => {
  const attestation = attestWebhookOriginUnder('https://shop.example.com/store-bravo/product/widget/')
  assert.equal(judgeWebhookOrigin(attestation, 'https://shop.example.com/store-b').verdict, 'foreign-store')
})

test('the verdicts separate "the delivery proved nothing" from "our own binding is unreadable"', () => {
  assert.equal(judgeWebhookOrigin('store:shop.example.com', 'https://shop.example.com').verdict, 'same-store')
  assert.equal(judgeWebhookOrigin('store:shop.example.com', 'https://other.example.com').verdict, 'foreign-store')
  // A fact about the DELIVERY that no waiting can improve.
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_PRE_ATTESTATION, 'https://shop.example.com').verdict, 'unproven')
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_NOT_STATED, 'https://shop.example.com').verdict, 'unproven')
  assert.equal(judgeWebhookOrigin(WEBHOOK_ORIGIN_LEGACY_WRITER, 'https://shop.example.com').verdict, 'unproven')
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

/**
 * FINDING 3. `X-WC-Webhook-Source` sits OUTSIDE the HMAC; `_links.self` and `permalink` sit
 * inside it. Round 2 read the header first, so a header rewritten in transit overrode the
 * signed body's own account of itself.
 */
test('a signed self-link outranks a contradictory unsigned source header', () => {
  const origin = readWcDeliveryOrigin(
    wcRequest({ 'x-wc-webhook-source': 'https://spoofed.example.com/' }),
    { _links: { self: [{ href: 'https://shop.example.com/wp-json/wc/v3/products/42' }] } },
  )
  assert.equal(origin, 'store:shop.example.com')
})

test('a signed permalink outranks a contradictory unsigned source header', () => {
  const origin = readWcDeliveryOrigin(
    wcRequest({ 'x-wc-webhook-source': 'https://spoofed.example.com/' }),
    { permalink: 'https://shop.example.com/product/widget/' },
  )
  assert.equal(origin, 'store-under:shop.example.com/product/widget')
})

test('a self-link is preferred over a permalink, because it yields the site root exactly', () => {
  const origin = readWcDeliveryOrigin(wcRequest({}), {
    permalink: 'https://shop.example.com/store-b/product/widget/',
    _links: { self: [{ href: 'https://shop.example.com/store-b/wp-json/wc/v3/products/42' }] },
  })
  assert.equal(origin, 'store:shop.example.com/store-b')
})

test('a self-link with no /wp-json/ boundary is kept as containment rather than guessed at', () => {
  // Plain permalinks: WordPress emits `<root>/?rest_route=/wc/v3/...`, which has no marker to
  // cut the site root at. Containment still holds and is still enough to place the delivery.
  const origin = readWcDeliveryOrigin(wcRequest({}), {
    _links: { self: [{ href: 'https://shop.example.com/store-b/?rest_route=/wc/v3/products/42' }] },
  })
  assert.equal(origin, 'store-under:shop.example.com/store-b')
  assert.equal(judgeWebhookOrigin(origin, 'https://shop.example.com/store-b').verdict, 'same-store')
  assert.equal(judgeWebhookOrigin(origin, 'https://shop.example.com/store-a').verdict, 'foreign-store')
})

test('with nothing signed to go on, the source header answers instead', () => {
  assert.equal(
    readWcDeliveryOrigin(wcRequest({ 'x-wc-webhook-source': 'https://shop.example.com/' }), { id: 42 }),
    'store:shop.example.com',
  )
})

test('a delivery with nothing to go on says so positively', () => {
  for (const payload of [null, undefined, 'a string', 42, {}, { permalink: '   ' }, { _links: { self: [] } }]) {
    assert.equal(readWcDeliveryOrigin(wcRequest({}), payload), WEBHOOK_ORIGIN_NOT_STATED, JSON.stringify(payload))
  }
})
