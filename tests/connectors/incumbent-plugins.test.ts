import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import {
  BRIDGE_PLUGIN_SLUG,
  INCUMBENTS_PATH,
  bridgeProbeViolations,
  fetchIncumbentsProbe,
  parseIncumbentsProbe,
  signIncumbentsProbe,
  xeroomNoteViolations,
} from '@/lib/connectors/woocommerce/incumbent-plugins'
import { helperReadHopRefusal } from '@/lib/connectors/woocommerce/aelia-rates'

const S = new Date('2027-01-04T00:00:00.000Z')
const clean = () => ({
  ok: true,
  generated_at: 1_800_000_000,
  bridge: { slug: BRIDGE_PLUGIN_SLUG, plugin_active: false, routes_registered: false, order_sync_enabled: false, product_webhook: { total: 1, active: 0 }, pending_product_jobs: 0, latest_mintsoft_write: Math.floor(S.getTime() / 1000) - 3600 },
  xeroom: { order_note_off: true, order_note_off_present: true },
})
const probeOf = (mutate: (b: ReturnType<typeof clean>) => void = () => {}) => { const b = clean(); mutate(b); return parseIncumbentsProbe(b)! }

test('the signature binds method, path, timestamp and nonce', () => {
  const sig = signIncumbentsProbe({ timestamp: 1_800_000_000, nonce: 'a'.repeat(32) }, 'sekret')
  assert.equal(sig, createHmac('sha256', 'sekret').update(`1800000000\nGET\n${INCUMBENTS_PATH}\n${'a'.repeat(32)}`).digest('hex'))
  assert.notEqual(sig, signIncumbentsProbe({ timestamp: 1_800_000_001, nonce: 'a'.repeat(32) }, 'sekret'))
  assert.notEqual(sig, signIncumbentsProbe({ timestamp: 1_800_000_000, nonce: 'b'.repeat(32) }, 'sekret'))
  assert.notEqual(sig, signIncumbentsProbe({ timestamp: 1_800_000_000, nonce: 'a'.repeat(32) }, 'other'))
})

test('a clean bridge answer has no violations; every deviation is its own closed code', () => {
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf(), mintsoftLiveFrom: S }), [])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.routes_registered = true }), mintsoftLiveFrom: S }), ['bridge-routes-registered'])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.order_sync_enabled = true }), mintsoftLiveFrom: S }), ['bridge-order-sync-enabled'])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.product_webhook = { total: 2, active: 1 } }), mintsoftLiveFrom: S }), ['bridge-product-webhook-active'])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.pending_product_jobs = 3 }), mintsoftLiveFrom: S }), ['bridge-product-jobs-pending'])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.slug = 'wc-mintsoft-sync-2' }), mintsoftLiveFrom: S }), ['bridge-slug-unexpected'])
})

test('the latest bridge write counts from S inclusive: a write at S is a violation, one a second before is not', () => {
  const at = Math.floor(S.getTime() / 1000)
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.latest_mintsoft_write = at }), mintsoftLiveFrom: S }), ['bridge-wrote-after-live-from'])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.latest_mintsoft_write = at - 1 }), mintsoftLiveFrom: S }), [])
  assert.deepEqual(bridgeProbeViolations({ probe: probeOf((b) => { b.bridge.latest_mintsoft_write = 0 }), mintsoftLiveFrom: S }), [])
})

test('a field the plugin could not read is a violation of its own, never taken as fine', () => {
  const probe = parseIncumbentsProbe({ ok: true, bridge: { slug: BRIDGE_PLUGIN_SLUG, routes_registered: null, order_sync_enabled: null, product_webhook: null, pending_product_jobs: null, latest_mintsoft_write: null }, xeroom: { order_note_off: null } })!
  assert.deepEqual(bridgeProbeViolations({ probe, mintsoftLiveFrom: S }).sort(), ['bridge-last-write-unreadable', 'bridge-order-sync-unreadable', 'bridge-product-jobs-unreadable', 'bridge-product-webhook-unreadable', 'bridge-routes-unreadable'])
  assert.deepEqual(xeroomNoteViolations(probe), ['xeroom-note-option-unreadable'])
})

test('Xeroom: the option on is clean; off or absent (the default) is a violation', () => {
  assert.deepEqual(xeroomNoteViolations(probeOf()), [])
  assert.deepEqual(xeroomNoteViolations(probeOf((b) => { b.xeroom.order_note_off = false })), ['xeroom-note-on'])
})

test('an answer that is not the success shape is not a probe', () => {
  assert.equal(parseIncumbentsProbe({ ok: false }), null)
  assert.equal(parseIncumbentsProbe(null), null)
  assert.equal(parseIncumbentsProbe({ ok: true, bridge: {} }), null)
  assert.equal(parseIncumbentsProbe('x'), null)
})

test('the hop gate allows the probe path and nothing else on the plugin', () => {
  const base = new URL('https://shop.example.com/')
  const hop = (url: string, method = 'GET') => ({ method, url: new URL(url), redirectCount: 0 })
  assert.equal(helperReadHopRefusal(base, hop(`https://shop.example.com${INCUMBENTS_PATH}`)), null)
  assert.equal(helperReadHopRefusal(base, hop(`https://shop.example.com${INCUMBENTS_PATH}`, 'POST')), 'method')
  assert.equal(helperReadHopRefusal(base, hop(`https://shop.example.com${INCUMBENTS_PATH}?x=1`)), 'parameter')
})

test('the fetch: one signed GET with timestamp, nonce and signature headers, redirects refused', async () => {
  const seen: Array<{ url: string; init: RequestInit; options: Record<string, unknown> }> = []
  const fetchImpl = (async (url: URL | string, init: RequestInit, options: Record<string, unknown>) => {
    seen.push({ url: String(url), init, options })
    return new Response(JSON.stringify(clean()), { status: 200 })
  }) as never
  const result = await fetchIncumbentsProbe({ fetchImpl, settings: { url: 'https://shop.example.com', secret: 'sekret' }, now: () => 1_800_000_000_000, nonce: () => 'c'.repeat(32) })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, `https://shop.example.com${INCUMBENTS_PATH}`)
  assert.equal(seen[0]!.init.method, 'GET')
  assert.equal(seen[0]!.init.body, undefined)
  const headers = seen[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-OTI-Timestamp'], '1800000000')
  assert.equal(headers['X-OTI-Nonce'], 'c'.repeat(32))
  assert.equal(headers['X-OTI-Signature'], signIncumbentsProbe({ timestamp: 1_800_000_000, nonce: 'c'.repeat(32) }, 'sekret'))
  assert.equal(seen[0]!.options.refuseRedirects, true)
})

test('the fetch reports not configured, an HTTP failure, a non-JSON answer and a malformed one as closed reasons', async () => {
  assert.deepEqual((await fetchIncumbentsProbe({ settings: { url: '', secret: '' } })).ok, false)
  const reason = async (response: Response) => { const r = await fetchIncumbentsProbe({ fetchImpl: (async () => response) as never, settings: { url: 'https://shop.example.com', secret: 's' } }); return r.ok ? 'ok' : r.reason }
  assert.equal(await reason(new Response('nope', { status: 404 })), 'http_status')
  assert.equal(await reason(new Response('<html>', { status: 200 })), 'not_json')
  assert.equal(await reason(new Response('{"ok":false}', { status: 200 })), 'malformed')
  const thrown = await fetchIncumbentsProbe({ fetchImpl: (async () => { throw new Error('boom secret=zzz') }) as never, settings: { url: 'https://shop.example.com', secret: 's' } })
  assert.equal(thrown.ok, false)
  assert.ok(!JSON.stringify(thrown).includes('zzz'), 'no transport error text reaches the result')
})
