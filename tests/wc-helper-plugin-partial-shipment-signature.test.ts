import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as partialShipmentNs from '../lib/connectors/woocommerce/sync/partial-shipment.ts'

const ps = 'default' in partialShipmentNs
  ? partialShipmentNs.default as typeof import('../lib/connectors/woocommerce/sync/partial-shipment.ts')
  : partialShipmentNs
const { signPartialShipmentV2, signPartialShipmentLegacy, partialShipmentPath } = ps

/**
 * THE PARTIAL-SHIPMENT ROUTE'S SIGNATURE VERIFIER, RUN FOR REAL: the verifier and the atomic nonce claim are lifted out of the plugin and executed by
 * php with the few WordPress functions they call stubbed. The signature is produced by the IMS sender's own function, so the two sides are pinned to the
 * same canonical string.
 */
const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')
const SECRET = 'shared-secret'
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function phpFunction(name: string): string {
  const start = PHP.indexOf(`    function ${name}(`)
  assert.ok(start > 0, `${name} exists`)
  return PHP.slice(start, PHP.indexOf('\n}\n', start))
}
const constant = (name: string) => new RegExp(`^const ${name} = .*;$`, 'm').exec(PHP)![0]

type Req = { order: number; method?: string; body: string; headers: Record<string, string> }

/** Verify the same request `times` times against ONE claim table; returns each result code. */
function verify(req: Req, times = 1): string[] {
  const program = `<?php
const OTI_FX_SECRET_OPT = 'secret';
${constant('OTI_TS_REPLAY_WINDOW')}
class WP_Error { public $code; function __construct($c) { $this->code = $c; } }
function get_option($k, $d = '') { return '${SECRET}'; }
function absint($v) { return abs((int) $v); }
class WPDB { public $options = 'wp_options'; public $claims = [];
  function esc_like($s) { return $s; }
  function prepare($q, ...$a) { return json_encode([$q, $a]); }
  function query($p) { [$q, $a] = json_decode($p, true); if (strpos($q, 'INSERT') !== 0) return 0; if (isset($this->claims[$a[0]])) return 0; $this->claims[$a[0]] = 1; return 1; } }
$wpdb = new WPDB();
class WP_REST_Request implements ArrayAccess {
  function __construct(public $m, public $h, public $body, public $order) {}
  function get_header($k) { return $this->h[$k] ?? null; }
  function get_method() { return $this->m; }
  function get_body() { return $this->body; }
  function offsetGet($o): mixed { return $this->order; }
  function offsetExists($o): bool { return true; }
  function offsetSet($o, $v): void {}
  function offsetUnset($o): void {}
}
${phpFunction('oti_claim_nonce')}
${phpFunction('oti_verify_partial_shipment_signature')}
$r = new WP_REST_Request(${JSON.stringify(req.method ?? 'POST')}, json_decode(${JSON.stringify(JSON.stringify(req.headers))}, true), ${JSON.stringify(req.body)}, ${req.order});
$out = [];
for ($i = 0; $i < ${times}; $i++) { $v = oti_verify_partial_shipment_signature($r); $out[] = $v === true ? 'ok' : $v->code; }
echo json_encode($out);
`
  const result = spawnSync('php', ['-d', 'display_errors=1'], { input: program, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout) as string[]
}

const now = () => Math.floor(Date.now() / 1000)
const BODY = JSON.stringify({ part: 1, total_parts: 1, tracking_number: 'TN', shipment_num: '', items: [{ sku: 'ABC', qty: 1 }] })
const headersFor = (ts: number, order: number, body = BODY, nonce = NONCE) => ({
  'x-oti-timestamp': String(ts),
  'x-oti-nonce': nonce,
  'x-oti-signature-v2': signPartialShipmentV2({ timestamp: ts, orderId: String(order), nonce, body }, SECRET),
  'x-oti-signature': signPartialShipmentLegacy(body, SECRET),
})

// --- TS: the canonical string ---------------------------------------------------------------------------------------------------------------------

test('the sender signs "ts \\n POST \\n path \\n nonce \\n body" (the plugin\'s canonical string), the path carrying the order id', () => {
  const sig = signPartialShipmentV2({ timestamp: 1800000000, orderId: '4242', nonce: NONCE, body: BODY }, SECRET)
  const text = `1800000000\nPOST\n/wp-json/oti/v1/order/4242/partial-shipment\n${NONCE}\n${BODY}`
  assert.equal(sig, createHmac('sha256', SECRET).update(text).digest('hex'))
  assert.equal(partialShipmentPath('4242'), '/wp-json/oti/v1/order/4242/partial-shipment')
})

test('every part of the canonical string changes the signature (order id, timestamp, nonce, body, secret)', () => {
  const base = { timestamp: 1800000000, orderId: '4242', nonce: NONCE, body: BODY }
  const sig = signPartialShipmentV2(base, SECRET)
  for (const changed of [{ ...base, orderId: '4243' }, { ...base, timestamp: 1800000001 }, { ...base, nonce: 'b'.repeat(32) }, { ...base, body: BODY + ' ' }]) {
    assert.notEqual(signPartialShipmentV2(changed, SECRET), sig)
  }
  assert.notEqual(signPartialShipmentV2(base, 'other'), sig)
})

test('the legacy signature is the body-only HMAC (what a plugin older than 1.5.3 checks) and differs from the V2 signature', () => {
  assert.equal(signPartialShipmentLegacy(BODY, SECRET), createHmac('sha256', SECRET).update(BODY).digest('hex'))
  assert.notEqual(signPartialShipmentLegacy(BODY, SECRET), signPartialShipmentV2({ timestamp: 1, orderId: '1', nonce: NONCE, body: BODY }, SECRET))
})

// --- PHP: the verifier, run for real -----------------------------------------------------------------------------------------------------------

test('a correctly signed request is accepted ONCE; the same request replayed is refused (nonce)', () => {
  const ts = now()
  assert.deepEqual(verify({ order: 4242, body: BODY, headers: headersFor(ts, 4242) }, 3), ['ok', 'oti_ps_replayed', 'oti_ps_replayed'])
})

test('REGRESSION: a request signed for order 4242 is refused against the URL of order 4243', () => {
  const ts = now()
  assert.deepEqual(verify({ order: 4243, body: BODY, headers: headersFor(ts, 4242) }), ['oti_ps_bad_sig'])
})

test('REGRESSION: a stale or future timestamp is refused', () => {
  for (const skew of [-400, 400]) {
    const ts = now() + skew
    assert.deepEqual(verify({ order: 9, body: BODY, headers: headersFor(ts, 9) }), ['oti_ps_stale'], `skew ${skew}`)
  }
  const ts = now() - 290
  assert.deepEqual(verify({ order: 9, body: BODY, headers: headersFor(ts, 9) }), ['ok'], 'inside the 300 s window')
})

test('REGRESSION: the old body-only signature alone is refused (the new plugin requires the V2 headers)', () => {
  assert.deepEqual(verify({ order: 7, body: BODY, headers: { 'x-oti-signature': signPartialShipmentLegacy(BODY, SECRET) } }), ['oti_ps_missing_sig'])
  // Legacy signature presented in the V2 slot does not verify either.
  const ts = now()
  assert.deepEqual(verify({ order: 7, body: BODY, headers: { ...headersFor(ts, 7), 'x-oti-signature-v2': signPartialShipmentLegacy(BODY, SECRET) } }), ['oti_ps_bad_sig'])
})

test('a tampered body, a different method, a missing nonce or timestamp, and a malformed nonce are refused', () => {
  const ts = now()
  assert.deepEqual(verify({ order: 5, body: BODY.replace('ABC', 'XYZ'), headers: headersFor(ts, 5) }), ['oti_ps_bad_sig'])
  assert.deepEqual(verify({ order: 5, method: 'PUT', body: BODY, headers: headersFor(ts, 5) }), ['oti_ps_bad_sig'])
  const h = headersFor(ts, 5)
  assert.deepEqual(verify({ order: 5, body: BODY, headers: { ...h, 'x-oti-nonce': '' } }), ['oti_ps_missing_sig'])
  assert.deepEqual(verify({ order: 5, body: BODY, headers: { ...h, 'x-oti-timestamp': '' } }), ['oti_ps_missing_sig'])
  const bad = headersFor(ts, 5, BODY, 'not-hex-nonce!!')
  assert.deepEqual(verify({ order: 5, body: BODY, headers: bad }), ['oti_ps_missing_sig'])
})

test('a different nonce for the same order is a new request (accepted), and the route is registered with its own verifier', () => {
  const ts = now()
  assert.deepEqual(verify({ order: 5, body: BODY, headers: headersFor(ts, 5, BODY, 'c'.repeat(32)) }), ['ok'])
  const route = /register_rest_route\(OTI_FX_NAMESPACE, '\/order\/\(\?P<order_id>\\d\+\)\/partial-shipment', \[([\s\S]*?)\n    \]\);/.exec(PHP)
  assert.ok(route)
  assert.match(route![1]!, /'permission_callback'\s*=>\s*'oti_verify_partial_shipment_signature'/)
})

test('plugin version is 1.5.3 or later and the file has no syntax error', () => {
  const m = /^\s*\*\s*Version:\s+(\d+)\.(\d+)\.(\d+)\s*$/m.exec(PHP)!
  const [, a, b, c] = m.map(Number)
  assert.ok(a > 1 || b > 5 || (b === 5 && c! >= 3))
  assert.equal(spawnSync('php', ['-l', 'lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php']).status, 0)
})
