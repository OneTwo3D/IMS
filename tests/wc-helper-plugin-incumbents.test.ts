import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * THE COMPANION PLUGIN'S 1.5.0 ROUTES, RUN FOR REAL: the incumbents probe (read only) and the withdrawal-outcome route. The PHP source of each function
 * is lifted out of the plugin and executed by the php binary with the few WordPress functions it calls stubbed, so the signature rules, the single-use
 * nonce, the route-table check and the idempotent outcome are observed, not read off the text.
 */
const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')
const SECRET = 'shared-secret'
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function phpFunction(name: string): string {
  const start = PHP.indexOf(`    function ${name}(`)
  assert.ok(start > 0, `${name} exists`)
  return PHP.slice(start, PHP.indexOf('\n    }\n', start) + 7)
}
const constant = (name: string) => new RegExp(`^const ${name}\\s*= .*;$`, "m").exec(PHP)![0]
const php = (program: string) => {
  const result = spawnSync('php', ['-d', 'display_errors=1'], { input: `<?php\n${program}`, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

const STUBS = `
const OTI_FX_SECRET_OPT = 'secret';
${constant('OTI_TS_REPLAY_WINDOW')}
${constant('OTI_INCUMBENTS_WINDOW')}
${constant('OTI_BRIDGE_PLUGIN_SLUG')}
${constant('OTI_BRIDGE_REST_NAMESPACE')}
${constant('OTI_BRIDGE_SETTINGS_OPT')}
${constant('OTI_BRIDGE_PRODUCT_SYNC_HOOK')}
${constant('OTI_BRIDGE_WEBHOOK_URL_PART')}
${constant('OTI_XEROOM_NOTE_OFF_OPT')}
${constant('OTI_WDRAW_OUTCOME_ON_OPT')}
${constant('OTI_WDRAW_REQUEST_ID_OPT_PREFIX')}
${constant('OTI_WDRAW_STATUSES')}
function update_option($k, $v, $a = null) { $GLOBALS['options'][$k] = $v; $GLOBALS['option_writes'][] = $k; return true; }
class WP_Error { public $code; function __construct($c = '', $m = '', $d = []) { $this->code = $c; } function get_error_code() { return $this->code; } }
function is_wp_error($v) { return $v instanceof WP_Error; }
class WP_REST_Response { public $data; public $status; function __construct($d, $s = 200) { $this->data = $d; $this->status = $s; } }
function get_option($k, $d = '') { return $GLOBALS['options'][$k] ?? ($k === 'secret' ? '${SECRET}' : $d); }
function absint($v) { return abs((int) $v); }
function sanitize_textarea_field($v) { return (string) $v; }
/** The options table as the nonce claim sees it: INSERT IGNORE on a unique option_name answers 1 the first time and 0 after. */
class NonceWpdb { public $options = 'wp_options'; public $prefix = 'wp_'; public $claimed = [];
  function esc_like($v) { return $v; }
  function prepare($q, ...$a) { foreach ($a as $x) { $q = preg_replace('/%[sd]/', is_int($x) ? (string) $x : "'" . $x . "'", $q, 1); } return $q; }
  function query($q) { if (strpos($q, 'INSERT IGNORE') === 0) { preg_match("/VALUES \\('([^']*)'/", $q, $m); if (isset($this->claimed[$m[1]])) { return 0; } $this->claimed[$m[1]] = 1; return 1; } return 0; } }
class WP_REST_Request implements ArrayAccess {
  function __construct(public $m, public $h, public $body = "", public $order = 0) {}
  function get_header($k) { return $this->h[$k] ?? null; }
  function get_method() { return $this->m; }
  function get_body() { return $this->body; }
  function offsetGet($o): mixed { return $this->order; }
  function offsetExists($o): bool { return true; }
  function offsetSet($o, $v): void {}
  function offsetUnset($o): void {}
}
`

const sign = (ts: number, method: string, path: string, tail: string) => createHmac('sha256', SECRET).update(`${ts}\n${method}\n${path}\n${tail}`).digest('hex')
const now = () => Math.floor(Date.now() / 1000)
const PATH = '/wp-json/oti/v1/incumbents'

function probeVerify(input: { method?: string; ts: number; headerTs?: string; nonce?: string; signature: string }) {
  return php(`${STUBS}
$wpdb = new NonceWpdb();
${phpFunction('oti_claim_nonce')}
${phpFunction('oti_verify_incumbents_signature')}
$r = new WP_REST_Request(${JSON.stringify(input.method ?? 'GET')}, ['x-oti-signature' => ${JSON.stringify(input.signature)}, 'x-oti-timestamp' => ${JSON.stringify(input.headerTs ?? String(input.ts))}, 'x-oti-nonce' => ${JSON.stringify(input.nonce ?? NONCE)}]);
$a = oti_verify_incumbents_signature($r);
$b = oti_verify_incumbents_signature($r);
echo json_encode(['first' => $a === true ? 'ok' : $a->code, 'second' => $b === true ? 'ok' : $b->code]);`)
}

test('the plugin is 1.5.2 or later and the file has no syntax error', () => {
  const version = /^\s*\*\s*Version:\s+(\d+)\.(\d+)\.(\d+)\s*$/m.exec(PHP)!
  assert.ok(Number(version[1]) > 1 || Number(version[2]) > 5 || (Number(version[2]) === 5 && Number(version[3]) >= 2), `version ${version.slice(1).join('.')}`)
  const lint = spawnSync('php', ['-l', 'lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php'], { encoding: 'utf8' })
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
})

test('the probe: a correctly signed GET is accepted once; the same request is refused the second time (nonce)', () => {
  const ts = now()
  assert.deepEqual(probeVerify({ ts, signature: sign(ts, 'GET', PATH, NONCE) }), { first: 'ok', second: 'oti_inc_replayed' })
})

test('the probe: stale (outside 60 s), wrong method, wrong path, wrong nonce and a malformed nonce are all refused', () => {
  const ts = now()
  assert.equal(probeVerify({ ts: ts - 61, signature: sign(ts - 61, 'GET', PATH, NONCE) }).first, 'oti_inc_stale')
  assert.equal(probeVerify({ ts: ts - 30, signature: sign(ts - 30, 'GET', PATH, NONCE) }).first, 'ok', 'inside the short window')
  assert.equal(probeVerify({ ts, method: 'POST', signature: sign(ts, 'GET', PATH, NONCE) }).first, 'oti_inc_bad_sig', 'signed as GET, sent as POST')
  assert.equal(probeVerify({ ts, signature: sign(ts, 'GET', '/wp-json/oti/v1/aelia-rates', NONCE) }).first, 'oti_inc_bad_sig', 'signed for another path')
  assert.equal(probeVerify({ ts, signature: sign(ts, 'GET', PATH, 'b'.repeat(32)) }).first, 'oti_inc_bad_sig', 'signed over another nonce')
  assert.equal(probeVerify({ ts, nonce: 'short', signature: sign(ts, 'GET', PATH, 'short') }).first, 'oti_inc_missing_sig')
  assert.equal(probeVerify({ ts, signature: '' }).first, 'oti_inc_missing_sig')
})

type ProbeBody = { bridge: Record<string, unknown>; xeroom: Record<string, unknown> }
function probeBody(options: Record<string, unknown>, extra = ''): ProbeBody {
  return php(`${STUBS}
$GLOBALS['options'] = json_decode(${JSON.stringify(JSON.stringify(options))}, true);
${extra}
${phpFunction('oti_incumbents_bridge_routes_registered')}
${phpFunction('oti_incumbents_bridge_webhooks')}
${phpFunction('oti_incumbents_pending_product_sync_jobs')}
${phpFunction('oti_incumbents_latest_mintsoft_write')}
${phpFunction('oti_handle_incumbents')}
$resp = oti_handle_incumbents(new WP_REST_Request('GET', [], ''));
echo json_encode($resp->data);`) as unknown as ProbeBody
}

test('the probe reads the route table by the exact bridge namespace, the order-sync switch and the Xeroom option', () => {
  const noRoutes = probeBody({ wc_mintsoft_settings: { order_sync_enabled: false } }, `class FakeServer { function get_routes() { return ['/oti/v1/incumbents' => [], '/wc-mintsoft-sync-other/v1/x' => []]; } }
function rest_get_server() { return new FakeServer(); }`)
  assert.equal(noRoutes.bridge.routes_registered, false, 'a look-alike namespace is not the bridge')
  assert.equal(noRoutes.bridge.order_sync_enabled, false)
  assert.equal(noRoutes.bridge.slug, 'wc-mintsoft-sync')
  const withRoutes = probeBody({ wc_mintsoft_settings: { order_sync_enabled: 1 } }, `class FakeServer { function get_routes() { return ['/wc-mintsoft/v1/order/(?P<id>\\\\d+)/status' => []]; } }
function rest_get_server() { return new FakeServer(); }`)
  assert.equal(withRoutes.bridge.routes_registered, true)
  assert.equal(withRoutes.bridge.order_sync_enabled, true)
})

test('the probe answers null (never a guess) for what it cannot read, and reads Xeroom\'s option: absent means the note is on', () => {
  const unreadable = probeBody({})
  assert.equal(unreadable.bridge.routes_registered, null)
  assert.equal(unreadable.bridge.product_webhook, null)
  assert.equal(unreadable.bridge.pending_product_jobs, null)
  assert.equal(unreadable.bridge.latest_mintsoft_write, null)
  assert.equal(unreadable.xeroom.order_note_off, false)
  assert.equal(unreadable.xeroom.order_note_off_present, false)
  assert.equal(probeBody({ o3d_xeroom_order_note_off: 'yes' }).xeroom.order_note_off, true)
  assert.equal(probeBody({ o3d_xeroom_order_note_off: '0' }).xeroom.order_note_off, false)
  assert.equal(probeBody({ o3d_xeroom_order_note_off: '0' }).xeroom.order_note_off_present, true)
})

test('the probe handler writes nothing: no update_option, no add/update meta, no wpdb write', () => {
  const body = phpFunction('oti_handle_incumbents') + phpFunction('oti_incumbents_latest_mintsoft_write') + phpFunction('oti_incumbents_bridge_webhooks') + phpFunction('oti_incumbents_pending_product_sync_jobs') + phpFunction('oti_incumbents_bridge_routes_registered')
  for (const forbidden of ['update_option', 'add_option', 'delete_option', 'update_meta', 'add_order_note', '->insert(', '->update(', '->delete(', 'as_unschedule', 'as_schedule', '->save(']) {
    assert.ok(!body.includes(forbidden), `the read-only probe must not contain ${forbidden}`)
  }
})

const OUT_PATH = (id: number) => `/wp-json/oti/v1/order/${id}/withdrawal-outcome`
function outcomeVerify(input: { order: number; ts: number; body: string; signature: string; pathOrder?: number }) {
  return php(`${STUBS}
$wpdb = new NonceWpdb();
${phpFunction('oti_claim_nonce')}
${phpFunction('oti_verify_withdrawal_outcome_signature')}
$r = new WP_REST_Request('POST', ['x-oti-signature' => ${JSON.stringify(input.signature)}, 'x-oti-timestamp' => ${JSON.stringify(String(input.ts))}], ${JSON.stringify(input.body)}, ${input.pathOrder ?? input.order});
$a = oti_verify_withdrawal_outcome_signature($r);
$b = oti_verify_withdrawal_outcome_signature($r);
echo json_encode(['first' => $a === true ? 'ok' : $a->code, 'second' => $b === true ? 'ok' : $b->code]);`)
}

test('withdrawal-outcome: signed over the order path, single-use, and a TrackShip re-fire signature cannot be replayed on it', () => {
  const ts = now()
  const body = JSON.stringify({ order_id: 77, ts, nonce: NONCE, outcome: 'noted' })
  assert.deepEqual(outcomeVerify({ order: 77, ts, body, signature: sign(ts, 'POST', OUT_PATH(77), body) }), { first: 'ok', second: 'oti_wo_replayed' })
  const refireSig = sign(ts, 'POST', '/wp-json/oti/v1/order/77/trackship-refire', body)
  assert.equal(outcomeVerify({ order: 77, ts, body, signature: refireSig }).first, 'oti_wo_bad_sig')
  assert.equal(outcomeVerify({ order: 78, pathOrder: 78, ts, body, signature: sign(ts, 'POST', OUT_PATH(78), body) }).first, 'oti_wo_bad_body', 'the body names another order')
})

function outcomeHandle(body: Record<string, unknown>, state: { keys?: string[]; wbte?: 'ok' | 'none' | 'throws' | 'notpending' | 'notpendingrejected'; requestMeta?: number; ownMeta?: number; owner?: number; mapped?: number } = {}) {
  return php(`${STUBS}
$GLOBALS['notes'] = []; $GLOBALS['rejects'] = []; $GLOBALS['options'] = ${state.mapped ? `['oti_wdraw_req_77' => ${state.mapped}]` : '[]'}; $GLOBALS['option_writes'] = [];
class FakeWpdb { public $prefix = 'wp_'; public $options = 'wp_options'; function prepare($q, ...$a) { foreach ($a as $x) { $q = preg_replace('/%[sd]/', is_int($x) ? (string) $x : "'" . $x . "'", $q, 1); } return $q; }
  function get_var($q) { if (strpos($q, 'GET_LOCK') !== false) { return 1; } if (preg_match("/option_name = '([^']*)'/", $q, $m)) { return $GLOBALS['options'][$m[1]] ?? null; } return null; } function query($q) { return 1; } }
$wpdb = new FakeWpdb();
class FakeOrder { public $meta = ['_oti_wdraw_outcome_keys' => ${JSON.stringify(state.keys ?? [])}, '_mintsoft_wdraw_request_id' => ${state.requestMeta ?? 0}, '_oti_wdraw_request_id' => ${state.ownMeta ?? 0}];
  function get_meta($k) { return $this->meta[$k] ?? ''; }
  function update_meta_data($k, $v) { $this->meta[$k] = $v; }
  function add_order_note($n) { $GLOBALS['notes'][] = $n; return 1; }
  function save_meta_data() { $GLOBALS['meta_saved'] = true; }
  function save() { $GLOBALS['full_saved'] = true; return 1; } }
$GLOBALS['full_saved'] = false; $GLOBALS['meta_saved'] = false;
$GLOBALS['order'] = new FakeOrder();
function wc_get_order($id) { return $id === 77 ? $GLOBALS['order'] : false; }
${state.wbte === 'none' ? '' : `class WbteReq { function __construct(public $id, public $order_id) {} function is_rejected() { return ${state.wbte === 'notpendingrejected' ? 'true' : 'false'}; } }
class Wbte_Ewb_Request_Repository { function find($id) { return new WbteReq($id, ${state.owner ?? 77}); } }
class Wbte_Ewb_Request_Service { function __construct($r) {} function reject($id, $by, $reason) { ${state.wbte === 'throws' ? "throw new Exception('x');" : state.wbte === 'notpending' || state.wbte === 'notpendingrejected' ? "return new WP_Error('wbte_ewb_not_pending');" : "$GLOBALS['rejects'][] = [$id, $reason]; return true;"} } }`}
${phpFunction('oti_wdraw_request_id_for_order')}
${phpFunction('oti_handle_withdrawal_outcome')}
$r = new WP_REST_Request('POST', [], ${JSON.stringify(JSON.stringify(body))}, 77);
$resp = oti_handle_withdrawal_outcome($r);
echo json_encode(['code' => $resp instanceof WP_Error ? $resp->code : $resp->status, 'data' => $resp instanceof WP_Error ? null : $resp->data, 'notes' => $GLOBALS['notes'], 'rejects' => $GLOBALS['rejects'], 'keys' => $GLOBALS['order']->meta['_oti_wdraw_outcome_keys'], 'fullSaved' => $GLOBALS['full_saved'], 'metaSaved' => $GLOBALS['meta_saved'], 'optionWrites' => $GLOBALS['option_writes']]);`)
}

test('withdrawal-outcome: a note is added once per outcome key; a repeat adds nothing', () => {
  const body = { outcome: 'noted', outcome_key: 'hold:77:1', note: 'IMS: held' }
  const first = outcomeHandle(body)
  assert.deepEqual(first.data, { ok: true, result: 'noted' })
  assert.deepEqual(first.notes, ['IMS: held'])
  assert.deepEqual(first.keys, ['n:hold:77:1'])
  const again = outcomeHandle(body, { keys: ['n:hold:77:1'] })
  assert.deepEqual(again.data, { ok: true, result: 'already_done' })
  assert.deepEqual(again.notes, [])
  assert.deepEqual(outcomeHandle(body, { keys: ['hold:77:1'] }).notes, [], 'a key recorded before the two-marker form still counts')
})

test('withdrawal-outcome: the note is written WITHOUT a full order save (no modified time, no order.updated webhook, so no loop); only the meta is saved', () => {
  const done = outcomeHandle({ outcome: 'noted', outcome_key: 'hold:77:1', note: 'IMS: held' })
  assert.equal(done.fullSaved, false, '$order->save() would fire woocommerce_update_order and bring IMS straight back')
  assert.equal(done.metaSaved, true)
  assert.ok(!phpFunction('oti_handle_withdrawal_outcome').includes('$order->save()'), 'the handler never calls save()')
  assert.ok(!phpFunction('oti_capture_wdraw_request').includes('->save()'), 'capturing the request id never full-saves the order either')
})

test('withdrawal-outcome: a rejection that found no request is retried without a second note, and is never answered already_done', () => {
  const body = { outcome: 'rejected', outcome_key: 'after:77:9', note: 'IMS: despatched' }
  const first = outcomeHandle(body, { wbte: 'ok' })
  assert.equal((first.data as { result: string }).result, 'no_request')
  assert.deepEqual(first.keys, ['n:after:77:9'], 'the note is recorded, the rejection is not')
  const retry = outcomeHandle({ ...body, request_id: 9 }, { wbte: 'ok', keys: ['n:after:77:9'] })
  assert.equal((retry.data as { result: string }).result, 'rejected')
  assert.deepEqual(retry.notes, [], 'the note was already written')
  assert.deepEqual(retry.rejects, [[9, 'order already dispatched']])
  assert.deepEqual(retry.keys, ['n:after:77:9', 'r:after:77:9'])
})

test('withdrawal-outcome: a request id that belongs to ANOTHER order is never rejected (no_request)', () => {
  const body = { outcome: 'rejected', outcome_key: 'after:77:5', note: 'IMS: despatched', request_id: 9 }
  const foreign = outcomeHandle(body, { wbte: 'ok', owner: 78 })
  assert.equal((foreign.data as { result: string }).result, 'no_request')
  assert.deepEqual(foreign.rejects, [])
})

test('the incumbents nonce is claimed atomically: one INSERT IGNORE per nonce, so two replays cannot both pass', () => {
  assert.ok(!phpFunction('oti_verify_incumbents_signature').includes('get_transient'))
  assert.ok(phpFunction('oti_claim_nonce').includes('INSERT IGNORE'))
})

test('withdrawal-outcome: a rejection goes through the withdrawal plugin with the request id of the body (else the order meta), then the note', () => {
  const body = { outcome: 'rejected', outcome_key: 'after:77:1', note: 'IMS: despatched', reject_reason: 'order already dispatched', request_id: 9 }
  const done = outcomeHandle(body, { wbte: 'ok' })
  assert.equal((done.data as { result: string }).result, 'rejected')
  assert.deepEqual(done.rejects, [[9, 'order already dispatched']])
  assert.deepEqual(done.notes, ['IMS: despatched'])
  const fromMeta = outcomeHandle({ ...body, request_id: undefined }, { wbte: 'ok', requestMeta: 4 })
  assert.deepEqual(fromMeta.rejects, [[4, 'order already dispatched']])
  const fromOwn = outcomeHandle({ ...body, request_id: undefined }, { wbte: 'ok', mapped: 6, requestMeta: 4 })
  assert.deepEqual(fromOwn.rejects, [[6, 'order already dispatched']], 'the helper plugin\'s own record comes before the bridge\'s')
  // A stale `_oti_wdraw_request_id` order meta (persisted by a round-tripping client) is NOT a source any more.
  const stale = outcomeHandle({ ...body, request_id: undefined }, { wbte: 'ok', ownMeta: 6 })
  assert.equal((stale.data as { result: string }).result, 'no_request')
})

test('withdrawal-outcome: no request id, no withdrawal plugin and a failing reject are told apart; the note is never lost on the first two', () => {
  const body = { outcome: 'rejected', outcome_key: 'after:77:2', note: 'IMS: despatched' }
  const noRequest = outcomeHandle(body, { wbte: 'ok' })
  assert.equal((noRequest.data as { result: string }).result, 'no_request')
  assert.deepEqual(noRequest.notes, ['IMS: despatched'])
  const noPlugin = outcomeHandle({ ...body, request_id: 9 }, { wbte: 'none' })
  assert.equal((noPlugin.data as { result: string }).result, 'no_withdrawal_plugin')
  assert.deepEqual(noPlugin.notes, ['IMS: despatched'])
  const failed = outcomeHandle({ ...body, request_id: 9 }, { wbte: 'throws' })
  assert.equal(failed.code, 502)
  assert.deepEqual(failed.notes, [], 'a failed rejection adds no note and records no key, so the retry does it all')
  assert.deepEqual(failed.keys, [])
})

test('withdrawal-outcome: unknown outcome, missing key and unknown order are refused', () => {
  assert.equal(outcomeHandle({ outcome: 'approved', outcome_key: 'k'.repeat(10) }).code, 'oti_wo_bad_outcome')
  assert.equal(outcomeHandle({ outcome: 'noted', outcome_key: '' }).code, 'oti_wo_bad_key')
})

test('withdrawal-outcome: a request that is not pending counts as rejected only if it IS rejected; an approved one is not_rejected and adds no note', () => {
  const body = { outcome: 'rejected', outcome_key: 'after:77:3', note: 'IMS: despatched', request_id: 9 }
  const approved = outcomeHandle(body, { wbte: 'notpending' })
  assert.equal((approved.data as { result: string }).result, 'not_rejected')
  assert.deepEqual(approved.notes, [])
  assert.deepEqual(approved.keys, [])
  const rejected = outcomeHandle(body, { wbte: 'notpendingrejected' })
  assert.equal((rejected.data as { result: string }).result, 'rejected')
})

test('withdrawal-outcome: the lock is taken before the order and its markers are read, and the request id comes from the captured option before the bridge meta', () => {
  const fn = phpFunction('oti_handle_withdrawal_outcome')
  assert.ok(fn.indexOf('GET_LOCK') < fn.indexOf('wc_get_order('), 'GET_LOCK first, then the order')
  const mapped = outcomeHandle({ outcome: 'rejected', outcome_key: 'after:77:4', note: 'n', request_id: undefined }, { wbte: 'ok', mapped: 12, requestMeta: 6 })
  assert.deepEqual(mapped.rejects, [[12, 'order already dispatched']])
  assert.ok((mapped.optionWrites as string[]).includes('oti_withdrawal_outcome_enabled'), 'IMS posting an outcome switches the capture on')
})

function captureRun(options: Record<string, unknown>, requestId = 31) {
  return php(`${STUBS}
$GLOBALS['options'] = json_decode(${JSON.stringify(JSON.stringify(options))}, true); $GLOBALS['option_writes'] = [];
class CapOrder { public $meta_writes = 0; function get_id() { return 77; } function update_meta_data($k, $v) { $this->meta_writes++; } function save_meta_data() { $this->meta_writes++; } function save() { $this->meta_writes++; } }
function add_action() {} function add_filter() {}
${phpFunction('oti_capture_wdraw_request')}
$o = new CapOrder();
oti_capture_wdraw_request((object) ['id' => ${requestId}], $o);
echo json_encode(['orderWrites' => $o->meta_writes, 'optionWrites' => $GLOBALS['option_writes'], 'map' => $GLOBALS['options']['oti_wdraw_req_77'] ?? null]);`)
}

test('capture hook: writes NO order meta ever; inert until IMS switches the outcome on; then it records the id in a per-order option', () => {
  const off = captureRun({})
  assert.deepEqual(off, { orderWrites: 0, optionWrites: [], map: null }, 'P1: the plugin writes nothing')
  const on = captureRun({ oti_withdrawal_outcome_enabled: 'yes' })
  assert.equal(on.orderWrites, 0, 'the order is never saved')
  assert.equal(on.map, 31, 'one option per order: no shared map to lose an entry from')
  assert.deepEqual(captureRun({ oti_withdrawal_outcome_enabled: 'yes', oti_wdraw_req_77: 31 }).optionWrites, [], 'an unchanged id writes nothing')
  assert.ok(!/update_meta_data|save_meta_data|->save\(/.test(phpFunction('oti_capture_wdraw_request')))
})

function exposeRun(options: Record<string, unknown>, order: { status: string; keys?: string[] }) {
  return php(`${STUBS}
$GLOBALS['options'] = json_decode(${JSON.stringify(JSON.stringify(options))}, true); $GLOBALS['lookups'] = 0;
class ExpWpdb { public $options = 'wp_options'; function prepare($q, ...$a) { foreach ($a as $x) { $q = preg_replace('/%[sd]/', "'" . $x . "'", $q, 1); } return $q; }
  function get_var($q) { $GLOBALS['lookups']++; preg_match("/option_name = '([^']*)'/", $q, $m); return $GLOBALS['options'][$m[1]] ?? null; } }
$wpdb = new ExpWpdb();
function apply_filters($tag, $v) { return $v; }
class ExpOrder { function get_id() { return 77; } function get_status() { return ${JSON.stringify(order.status)}; } function get_meta($k) { return $k === '_oti_wdraw_outcome_keys' ? ${JSON.stringify(order.keys ?? [])} : ''; } }
function add_action() {} function add_filter() {}
${phpFunction('oti_wdraw_request_id_for_order')}
${phpFunction('oti_expose_wdraw_request_id')}
$r = new WP_REST_Response(['id' => 77, 'meta_data' => [['id' => 5, 'key' => 'x', 'value' => 'y']]]);
$out = oti_expose_wdraw_request_id($r, new ExpOrder());
echo json_encode(['data' => $out->data, 'lookups' => $GLOBALS['lookups']]);`) as { data: { meta_data: unknown[]; _oti_wdraw_request_id?: number }; lookups: number }
}

test('REST prepare filter: the request id is a TOP-LEVEL response field, never a meta_data entry (so a round-tripping client cannot persist it); nothing is added without a capture', () => {
  const on = { oti_withdrawal_outcome_enabled: 'yes' }
  const captured = exposeRun({ ...on, oti_wdraw_req_77: 31 }, { status: 'pending-wdraw' })
  assert.equal(captured.data._oti_wdraw_request_id, 31)
  assert.equal(captured.lookups, 1, 'one single-row select')
  assert.deepEqual(captured.data.meta_data, [{ id: 5, key: 'x', value: 'y' }], 'meta_data is untouched: no synthetic id-0 entry')
  assert.equal(exposeRun(on, { status: 'pending-wdraw' }).data._oti_wdraw_request_id, undefined)
  assert.equal(exposeRun({ ...on, oti_wdraw_req_77: 31 }, { status: 'cancelled', keys: ['n:k'] }).data._oti_wdraw_request_id, 31, 'an order IMS already wrote an outcome on stays visible after its status moved on')
})

test('REST prepare filter: an order that is not in a withdrawal status, or any order while the capture switch is off, does NO lookup (no per-order notoptions entry, no query)', () => {
  const on = { oti_withdrawal_outcome_enabled: 'yes', oti_wdraw_req_77: 31 }
  for (const status of ['processing', 'completed', 'on-hold', 'cancelled']) {
    const run = exposeRun(on, { status })
    assert.equal(run.lookups, 0, `${status}: no lookup`)
    assert.equal(run.data._oti_wdraw_request_id, undefined)
  }
  const off = exposeRun({ oti_wdraw_req_77: 31 }, { status: 'pending-wdraw' })
  assert.equal(off.lookups, 0, 'switch off (P1): no lookup even for a withdrawal order')
  assert.equal(off.data._oti_wdraw_request_id, undefined)
  const src = phpFunction('oti_expose_wdraw_request_id') + phpFunction('oti_wdraw_request_id_for_order')
  assert.ok(!/get_option\(\s*OTI_WDRAW_REQUEST_ID_OPT_PREFIX|get_option\(\s*\$option|get_option\(\s*\$name/.test(src), 'the per-order option is read with $wpdb, never get_option (a miss would add a notoptions entry)')
})

test('order deletion forgets only that order\'s request option; and the outcome route no longer reads a `_oti_wdraw_request_id` order meta', () => {
  const out = php(`${STUBS}
$GLOBALS['options'] = ['oti_wdraw_req_77' => 31, 'oti_wdraw_req_78' => 32]; $GLOBALS['deleted'] = [];
function delete_option($k) { $GLOBALS['deleted'][] = $k; unset($GLOBALS['options'][$k]); return true; }
${phpFunction('oti_forget_wdraw_request')}
oti_forget_wdraw_request(77);
echo json_encode(['deleted' => $GLOBALS['deleted'], 'left' => array_keys($GLOBALS['options'])]);`)
  assert.deepEqual(out, { deleted: ['oti_wdraw_req_77'], left: ['oti_wdraw_req_78'] })
  assert.ok(!phpFunction('oti_handle_withdrawal_outcome').includes("get_meta('_oti_wdraw_request_id')"))
})

test('delete_post cleanup looks only at order post types (a revision, attachment or product delete costs nothing); HPOS order deletion has its own hook', () => {
  const run = (type: string) => php(`${STUBS}
$GLOBALS['deleted'] = [];
function get_post_type($id) { return ${JSON.stringify(type)}; }
function delete_option($k) { $GLOBALS['deleted'][] = $k; return true; }
${phpFunction('oti_forget_wdraw_request')}
${phpFunction('oti_forget_wdraw_request_for_post')}
oti_forget_wdraw_request_for_post(77);
echo json_encode(['deleted' => $GLOBALS['deleted']]);`)
  assert.deepEqual(run('revision'), { deleted: [] })
  assert.deepEqual(run('attachment'), { deleted: [] })
  assert.deepEqual(run('product'), { deleted: [] })
  assert.deepEqual(run('shop_order'), { deleted: ['oti_wdraw_req_77'] })
  assert.match(PHP, /add_action\('woocommerce_delete_order', 'oti_forget_wdraw_request'/)
  assert.match(PHP, /add_action\('delete_post', 'oti_forget_wdraw_request_for_post'/)
})
