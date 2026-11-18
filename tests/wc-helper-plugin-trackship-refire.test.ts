import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * THE COMPANION PLUGIN'S TRACKSHIP RE-FIRE ROUTE, RUN FOR REAL: the signature verifier's PHP source is lifted out of the plugin and executed by
 * the php binary with the few WordPress functions it calls stubbed (get_option, absint, transients, WP_Error, a request object). So the cross-order
 * replay, the stale timestamp and the nonce reuse are observed, not read off the text.
 */
const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')
const SECRET = 'shared-secret'

function phpFunction(name: string): string {
  const start = PHP.indexOf(`    function ${name}(`)
  assert.ok(start > 0, `${name} exists`)
  const next = PHP.indexOf('\n}\n', start)
  return PHP.slice(start, next)
}
const constant = (name: string) => new RegExp(`^const ${name} = .*;$`, 'm').exec(PHP)![0]

function verify(request: { order: number; method?: string; body: string; timestamp: string; signature: string }, store: string[] = []): { code: string } {
  const program = `<?php
const OTI_FX_SECRET_OPT = 'secret';
${constant('OTI_TS_REPLAY_WINDOW')}
class WP_Error { public $code; function __construct($c) { $this->code = $c; } }
function get_option($k, $d = '') { return '${SECRET}'; }
function absint($v) { return abs((int) $v); }
$GLOBALS['t'] = array_flip(json_decode('${JSON.stringify(store)}', true));
function get_transient($k) { return isset($GLOBALS['t'][$k]) ? 1 : false; }
function set_transient($k, $v, $e) { $GLOBALS['t'][$k] = 1; }
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
${phpFunction('oti_verify_trackship_refire_signature')}
$r = new WP_REST_Request(${JSON.stringify(request.method ?? 'POST')}, ['x-oti-signature' => ${JSON.stringify(request.signature)}, 'x-oti-timestamp' => ${JSON.stringify(request.timestamp)}], ${JSON.stringify(request.body)}, ${request.order});
$v = oti_verify_trackship_refire_signature($r);
echo json_encode(['code' => $v === true ? 'ok' : $v->code, 'second' => (function() use ($r) { $v = oti_verify_trackship_refire_signature($r); return $v === true ? 'ok' : $v->code; })()]);
`
  const result = spawnSync('php', ['-d', 'display_errors=1'], { input: program, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout) as { code: string }
}

const sign = (ts: number, order: number, body: string, method = 'POST') =>
  createHmac('sha256', SECRET).update(`${ts}\n${method}\n/wp-json/oti/v1/order/${order}/trackship-refire\n${body}`).digest('hex')
const now = () => Math.floor(Date.now() / 1000)
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const bodyFor = (order: number, ts: number, nonce = NONCE) => JSON.stringify({ order_id: order, ts, nonce })

test('a correctly signed request is accepted once and the SAME request is refused the second time (nonce)', () => {
  const ts = now(); const body = bodyFor(4242, ts)
  const result = verify({ order: 4242, body, timestamp: String(ts), signature: sign(ts, 4242, body) }) as { code: string; second: string }
  assert.equal(result.code, 'ok')
  assert.equal(result.second, 'oti_ts_replayed')
})

test('REGRESSION: a request signed for order 4242 is refused against the URL of order 4243', () => {
  const ts = now(); const body = bodyFor(4242, ts)
  const captured = sign(ts, 4242, body)
  assert.equal(verify({ order: 4243, body, timestamp: String(ts), signature: captured }).code, 'oti_ts_bad_sig')
  // Even a signature the attacker could make for the new path does not help without the secret; and a body naming the other order fails the id check.
  const forgedBody = bodyFor(4242, ts, 'ffffffffffffffffffffffffffffffff')
  assert.equal(verify({ order: 4243, body: forgedBody, timestamp: String(ts), signature: sign(ts, 4243, forgedBody) }).code, 'oti_ts_bad_body')
})

test('REGRESSION: a timestamp outside the replay window is refused, in the past and in the future', () => {
  for (const skew of [-400, 400]) {
    const ts = now() + skew; const body = bodyFor(9, ts)
    assert.equal(verify({ order: 9, body, timestamp: String(ts), signature: sign(ts, 9, body) }).code, 'oti_ts_stale', `skew ${skew}`)
  }
})

test('the method is signed, a missing timestamp or nonce is refused, and a body ts that differs from the header is refused', () => {
  const ts = now(); const body = bodyFor(5, ts)
  assert.equal(verify({ order: 5, method: 'PUT', body, timestamp: String(ts), signature: sign(ts, 5, body, 'POST') }).code, 'oti_ts_bad_sig')
  assert.equal(verify({ order: 5, body, timestamp: '', signature: sign(ts, 5, body) }).code, 'oti_ts_missing_sig')
  const noNonce = JSON.stringify({ order_id: 5, ts })
  assert.equal(verify({ order: 5, body: noNonce, timestamp: String(ts), signature: sign(ts, 5, noNonce) }).code, 'oti_ts_no_nonce')
  const otherTs = JSON.stringify({ order_id: 5, ts: ts - 1, nonce: NONCE })
  assert.equal(verify({ order: 5, body: otherTs, timestamp: String(ts), signature: sign(ts, 5, otherTs) }).code, 'oti_ts_bad_body')
})

test('the route is registered with its own verifier, and refuses orders outside the 7 day window before it fires', () => {
  const route = /register_rest_route\(OTI_FX_NAMESPACE, '\/order\/\(\?P<order_id>\\d\+\)\/trackship-refire', \[([\s\S]*?)\n    \]\);/.exec(PHP)
  assert.ok(route)
  assert.match(route![1]!, /'permission_callback'\s*=>\s*'oti_verify_trackship_refire_signature'/)
  const handler = phpFunction('oti_handle_trackship_refire')
  assert.match(PHP, /^const OTI_TS_WINDOW = 604800;$/m)
  assert.ok(handler.indexOf("'outside_window'") > 0 && handler.indexOf("'outside_window'") < handler.indexOf("do_action('send_order_to_trackship'"), 'the window refusal comes before the fire')
})

/**
 * THE HANDLER, RUN FOR REAL (same lifting): TrackShip's items and shipment rows are stubbed, `do_action` records whether the order-wide action fired.
 */
type Item = { tracking_number: string; date_shipped?: unknown }
function runHandler(items: Item[], rows: Array<{ tracking_number: string; shipment_status: string }>): { result: string; fired: boolean; outside_window?: number } {
  const program = `<?php
${constant('OTI_TS_PENDING_GRACE')}
${constant('OTI_TS_WINDOW')}
class WP_Error { function __construct(public $code = '', public $msg = '', public $data = []) {} }
class WP_REST_Response { function __construct(public $data, public $status = 200) {} }
class WP_REST_Request implements ArrayAccess { function offsetGet($o): mixed { return 77; } function offsetExists($o): bool { return true; } function offsetSet($o, $v): void {} function offsetUnset($o): void {} }
function absint($v) { return abs((int) $v); }
function wc_get_order($id) { return new stdClass(); }
class TS { function get_tracking_items($id, $f) { return json_decode('${JSON.stringify(items)}', true); } }
function trackship_for_woocommerce() { return new TS(); }
function apply_filters($tag, $v, ...$a) { return true; }
$GLOBALS['fired'] = false;
function do_action($tag, ...$a) { if ($tag === 'send_order_to_trackship') $GLOBALS['fired'] = true; }
class WPDB { public $prefix = 'wp_'; public $last_error = '';
  function get_var($q) { return 1; } function query($q) { return 1; } function prepare($q, ...$a) { return $q; }
  function get_results($q) { return array_map(fn($r) => (object) $r, json_decode('${JSON.stringify(rows)}', true)); } }
$wpdb = new WPDB();
${phpFunction('oti_handle_trackship_refire')}
$r = oti_handle_trackship_refire(new WP_REST_Request());
echo json_encode(array_merge($r->data, ['fired' => $GLOBALS['fired']]));
`
  const result = spawnSync('php', ['-d', 'display_errors=1'], { input: program, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout)
}
const DAY = 86_400
const ago = (days: number) => now() - Math.round(days * DAY)

test('REGRESSION: a missing tracking number with no usable despatch date fails closed (never "recent"): nothing fires', () => {
  for (const date of [undefined, '', 0, '0', 'garbage', null, -5]) {
    const outcome = runHandler([{ tracking_number: 'OLD', date_shipped: date }], [])
    assert.equal(outcome.result, 'outside_window', `date ${String(date)}`)
    assert.equal(outcome.fired, false)
  }
})

test('REGRESSION: a recent parcel is repaired even when an older parcel of the same order is missing too (each number is judged on its own)', () => {
  const outcome = runHandler([{ tracking_number: 'OLD', date_shipped: String(ago(20)) }, { tracking_number: 'NEW', date_shipped: String(ago(1)) }], [])
  assert.equal(outcome.result, 'fired')
  assert.equal(outcome.fired, true)
  assert.equal(outcome.outside_window, 1, 'the answer says an old parcel was missing too (it is re-registered with the order-wide action)')
})

test('an order whose every missing number is outside the window is refused, and a covered recent one beside it does not change that', () => {
  const rows = [{ tracking_number: 'NEW', shipment_status: 'in_transit' }]
  const outcome = runHandler([{ tracking_number: 'OLD', date_shipped: String(ago(20)) }, { tracking_number: 'NEW', date_shipped: String(ago(1)) }], rows)
  assert.equal(outcome.result, 'outside_window')
  assert.equal(outcome.fired, false)
})

test('control: a recent missing parcel fires, a covered order does not, a pending row older than the grace is missing again', () => {
  assert.deepEqual([runHandler([{ tracking_number: 'A', date_shipped: String(ago(1)) }], []).fired], [true])
  assert.equal(runHandler([{ tracking_number: 'A', date_shipped: String(ago(1)) }], [{ tracking_number: 'A', shipment_status: 'in_transit' }]).result, 'covered')
  assert.equal(runHandler([{ tracking_number: 'A', date_shipped: String(ago(1)) }], [{ tracking_number: 'A', shipment_status: 'pending_trackship' }]).fired, true)
  assert.equal(runHandler([{ tracking_number: 'A', date_shipped: String(now() - 60) }], [{ tracking_number: 'A', shipment_status: 'pending_trackship' }]).result, 'covered')
})
