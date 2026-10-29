import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AELIA_RATES_PATH, HELPER_READ_ALLOWLIST, helperReadHopRefusal, readAeliaRatesFromWc } from '@/lib/connectors/woocommerce/aelia-rates'

/**
 * (1) THE TRANSPORT: a GET to exactly /wp-json/oti/v1/aelia-rates on the store's own origin, signed like the plugin's other endpoints, through the connector fetch seam.
 * (2) THE PLUGIN'S SIDE. The repository has NO PHP test runner (no phpunit, no composer, no CI step that runs php), so the endpoint is pinned here BY READING THE SOURCE: its route, its method,
 *     its authentication, its read of Aelia's option, the separate return of rate and markup, and that its handler has no write. This is a source pin, not an execution of the PHP.
 */

const BASE = new URL('https://shop.example.com/')
const hop = (url: string, method = 'GET', redirectCount = 0) => ({ method, url: new URL(url), redirectCount })
const GOOD = `https://shop.example.com${AELIA_RATES_PATH}`

test('the allowlist is ONE path with NO parameters', () => {
  assert.deepEqual(HELPER_READ_ALLOWLIST, [{ path: '/wp-json/oti/v1/aelia-rates', params: {} }])
})

test('hop gate: the one allowed request passes; every other shape is refused before it is sent', () => {
  assert.equal(helperReadHopRefusal(BASE, hop(GOOD)), null)
  assert.equal(helperReadHopRefusal(BASE, hop(GOOD, 'POST')), 'method')
  assert.equal(helperReadHopRefusal(BASE, hop(GOOD, 'PUT')), 'method')
  assert.equal(helperReadHopRefusal(BASE, hop(GOOD, 'GET', 1)), 'redirect')
  assert.equal(helperReadHopRefusal(BASE, hop('https://shop.example.com/wp-json/oti/v1/fx-rates')), 'path', 'the signed push route is not readable through this gate')
  assert.equal(helperReadHopRefusal(BASE, hop('https://shop.example.com/wp-json/wc/v3/orders')), 'path')
  assert.equal(helperReadHopRefusal(BASE, hop(`${GOOD}/extra`)), 'path')
  assert.equal(helperReadHopRefusal(BASE, hop(`${GOOD}?force=1`)), 'parameter')
  assert.equal(helperReadHopRefusal(BASE, hop(`${GOOD}?_method=POST`)), 'parameter')
  assert.equal(helperReadHopRefusal(BASE, hop(`https://evil.example.com${AELIA_RATES_PATH}`)), 'origin')
  assert.equal(helperReadHopRefusal(BASE, hop(`https://user:pw@shop.example.com${AELIA_RATES_PATH}`)), 'origin')
  assert.equal(helperReadHopRefusal(BASE, hop(`${GOOD}#x`)), 'origin')
  // a store in a sub-directory keeps its prefix
  assert.equal(helperReadHopRefusal(new URL('https://shop.example.com/store/'), hop(`https://shop.example.com/store${AELIA_RATES_PATH}`)), null)
  assert.equal(helperReadHopRefusal(new URL('https://shop.example.com/store/'), hop(GOOD)), 'path')
})

test('the read: a GET with an empty body, signed with HMAC-SHA256 of the empty body, redirects refused, through the injected seam', async () => {
  const seen: Array<{ url: string; init: RequestInit; options: Record<string, unknown> }> = []
  const fetchImpl = (async (url: URL | string, init: RequestInit, options: Record<string, unknown>) => {
    seen.push({ url: String(url), init, options })
    // the gate handed to the seam is the one of this module
    const gate = options.hopGate as (h: ReturnType<typeof hop>) => string | null
    assert.equal(gate(hop(String(url))), null)
    assert.equal(gate(hop(String(url), 'POST')), 'method')
    return new Response(JSON.stringify({ ok: true, rates: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as never
  const result = await readAeliaRatesFromWc({ fetchImpl, settings: { url: 'https://shop.example.com', secret: 'sekret' } })
  assert.deepEqual(result, { ok: true, body: { ok: true, rates: [] } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `https://shop.example.com${AELIA_RATES_PATH}`)
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.body, undefined)
  assert.equal((seen[0].init.headers as Record<string, string>)['X-OTI-Signature'], createHmac('sha256', 'sekret').update('').digest('hex'))
  assert.equal(seen[0].options.refuseRedirects, true)
})

test('the read: not configured makes no request; a non-2xx and a non-JSON answer are reported, not guessed at', async () => {
  let count = 0
  const counting = (async () => { count += 1; return new Response('nope', { status: 404 }) }) as never
  const none = await readAeliaRatesFromWc({ fetchImpl: counting, settings: { url: '', secret: 'x' } })
  assert.equal(none.ok, false)
  assert.equal(count, 0)
  const noSecret = await readAeliaRatesFromWc({ fetchImpl: counting, settings: { url: 'https://shop.example.com', secret: '' } })
  assert.equal(noSecret.ok, false)
  assert.equal(count, 0, 'no shared secret, no request (an unsigned read is never sent)')
  const notFound = await readAeliaRatesFromWc({ fetchImpl: counting, settings: { url: 'https://shop.example.com', secret: 'x' } })
  assert.deepEqual([notFound.ok, notFound.ok ? '' : notFound.reason], [false, 'http_status'])
  const html = (async () => new Response('<html>', { status: 200 })) as never
  const bad = await readAeliaRatesFromWc({ fetchImpl: html, settings: { url: 'https://shop.example.com', secret: 'x' } })
  assert.deepEqual([bad.ok, bad.ok ? '' : bad.reason], [false, 'not_json'])
  const thrown = (async () => { throw new Error('refused by hop gate') }) as never
  const err = await readAeliaRatesFromWc({ fetchImpl: thrown, settings: { url: 'https://shop.example.com', secret: 'x' } })
  assert.deepEqual([err.ok, err.ok ? '' : err.reason], [false, 'unreachable'])
})

// ------------------------------------------------------------------ the plugin's source

const PHP = readFileSync('lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php', 'utf8')

function phpFunction(name: string): string {
  const start = PHP.indexOf(`function ${name}(`)
  assert.ok(start > 0, `${name} exists`)
  const next = PHP.indexOf("\nif (!function_exists(", start)
  return PHP.slice(start, next > 0 ? next : undefined)
}

test('plugin source: version 1.3.0', () => {
  assert.match(PHP, /^\s*\*\s*Version:\s+1\.3\.0\s*$/m)
})

test('plugin source: the route is /aelia-rates, GET only, authenticated by the same signature check as the other signed routes', () => {
  const routes = [...PHP.matchAll(/register_rest_route\(OTI_FX_NAMESPACE, '([^']+)', \[([\s\S]*?)\n    \]\);/g)]
  const route = routes.find((m) => m[1] === '/aelia-rates')
  assert.ok(route, 'the route is registered')
  assert.match(route[2], /'methods'\s*=>\s*'GET'/)
  assert.doesNotMatch(route[2], /POST|PUT|PATCH|DELETE|CREATABLE|EDITABLE|ALLMETHODS/)
  assert.match(route[2], /'permission_callback'\s*=>\s*'oti_verify_fx_signature'/)
  assert.match(route[2], /'callback'\s*=>\s*'oti_handle_aelia_rates_read'/)
  assert.equal(routes.filter((m) => m[1] === '/aelia-rates').length, 1, 'registered once')
  // the existing signed routes use the very same permission callback
  const push = routes.find((m) => m[1] === '/fx-rates')
  assert.ok(push)
  assert.match(push[2], /'permission_callback'\s*=>\s*'oti_verify_fx_signature'/)
})

test('plugin source: the handler reads Aelia\'s settings option and returns rate and markup SEPARATELY', () => {
  assert.match(PHP, /const OTI_AELIA_SETTINGS_OPT = 'wc_aelia_currency_switcher';/)
  const body = phpFunction('oti_handle_aelia_rates_read')
  assert.match(body, /get_option\(OTI_AELIA_SETTINGS_OPT/)
  assert.match(body, /\$settings\['exchange_rates'\]/)
  assert.match(body, /'rate'\s*=>\s*isset\(\$row\['rate'\]\)/)
  assert.match(body, /'markup'\s*=>\s*isset\(\$row\['rate_markup'\]\)/)
  assert.match(body, /'set_manually'/)
  assert.match(body, /'decimals'/)
  assert.match(body, /'last_update'/)
  assert.match(body, /'base'/)
  // never combined: no arithmetic on the rate or the markup anywhere in the handler
  assert.doesNotMatch(body, /\$row\['rate'\]\s*[-+*\/]|[-+*\/]\s*\$row\['rate_markup'\]|\(float\)\s*\$row|floatval|bcadd/)
})

test('plugin source: the GET handler and its helper make NO write', () => {
  const writes = /\b(update_option|add_option|delete_option|delete_transient|set_transient|update_post_meta|add_post_meta|delete_post_meta|update_user_meta|wp_insert_\w+|wp_update_\w+|wp_delete_\w+|wp_remote_\w+|file_put_contents|fopen|unlink|curl_\w+|setcookie|header\()|\$wpdb|->(insert|update|delete|query|replace)\(/
  for (const name of ['oti_handle_aelia_rates_read', 'oti_aelia_last_update_iso']) {
    const body = phpFunction(name)
    assert.doesNotMatch(body, writes, `${name} has no write`)
  }
  // CONTROL: the same pattern sees a write when there is one, so it can fail
  assert.match("function x() { update_option('a', 1); }", writes)
  assert.match("function x() { $wpdb->query('x'); }", writes)
})

test('plugin source: the FX-rate WRITE endpoint is retired: it refuses with 410 oti_fx_push_retired and has no write', () => {
  const writes = /\b(update_option|add_option|delete_option|delete_transient|set_transient|wp_cache_\w+|update_post_meta|add_post_meta|wp_insert_\w+|wp_update_\w+|wp_remote_\w+|file_put_contents|fopen|unlink|curl_\w+|oti_invalidate_aelia_cache)\b|\$wpdb|->(insert|update|delete|query|replace)\(/
  const body = phpFunction('oti_handle_fx_push')
  assert.match(body, /new WP_Error\(\s*'oti_fx_push_retired'[\s\S]*?\['status' => 410\]/)
  assert.doesNotMatch(body.replace(/\/\*\*[\s\S]*?\*\//g, ''), writes, 'the retired receiver writes nothing')
  assert.doesNotMatch(body.replace(/\/\*\*[\s\S]*?\*\//g, ''), /get_json_params|get_body/, 'and does not even read the payload')
  // the route is still signature-checked first, so an unsigned request is still a 401
  assert.match(PHP, /register_rest_route\(OTI_FX_NAMESPACE, '\/fx-rates', \[\s*'methods'\s*=>\s*'POST',\s*'permission_callback'\s*=>\s*'oti_verify_fx_signature',\s*'callback'\s*=>\s*'oti_handle_fx_push'/)
  // no function of the plugin updates an FX option any more (nothing is left that could store a pushed rate)
  assert.doesNotMatch(PHP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /update_option\(\s*OTI_FX_(OPTION|BASE_OPT|LASTPUSH_OPT)/)
})

// ------------------------------------------------------------------ the live option's shape: an epoch-INTEGER update time, and a base row without rate_markup / set_manually

test('plugin source: the update time accepts an epoch integer (the live option stores exchange_rates_last_update that way) and renders it ISO-8601 UTC', () => {
  const body = phpFunction('oti_aelia_last_update_iso')
  assert.match(body, /'exchange_rates_last_update'/, 'the key the live option uses is the first one tried')
  assert.ok(body.indexOf("'exchange_rates_last_update'") < body.indexOf("'exchange_rates_update_time'"))
  assert.match(body, /is_numeric\(\$raw\)[\s\S]*?\(int\) \$raw/, 'a numeric value is an epoch')
  assert.match(body, /gmdate\('Y-m-d\\TH:i:s\\Z', \$ts\)/)
  // a row without rate_markup returns markup null, never a 0
  assert.match(phpFunction('oti_handle_aelia_rates_read'), /'markup'\s*=>\s*isset\(\$row\['rate_markup'\]\) \? trim\(\(string\) \$row\['rate_markup'\]\) : null/)
})

const PHP_BIN = spawnSync('php', ['-v']).status === 0 ? 'php' : null

/** Run the REAL plugin functions under the php CLI with the WordPress calls they make stubbed; returns the response data. */
function runHandler(option: unknown, currency = 'GBP'): unknown {
  const start = PHP.indexOf("if (!function_exists('oti_aelia_last_update_iso'))")
  const end = PHP.indexOf("if (!function_exists('oti_ps_parts_done'))")
  assert.ok(start > 0 && end > start)
  const script = `<?php
const OTI_AELIA_SETTINGS_OPT = 'wc_aelia_currency_switcher';
class WP_REST_Request {}
class WP_REST_Response { public $data; function __construct($d) { $this->data = $d; } }
class WP_Error { public $code; function __construct($c) { $this->code = $c; } }
function get_option($k, $d = null) { $o = json_decode(getenv('OPT'), true); return $k === 'woocommerce_currency' ? getenv('CUR') : ($o === null ? $d : $o); }
${PHP.slice(start, end)}
$r = oti_handle_aelia_rates_read(new WP_REST_Request());
echo json_encode($r instanceof WP_Error ? ['error' => $r->code] : $r->data);
`
  const res = spawnSync('php', ['-d', 'display_errors=stderr'], { input: script, env: { ...process.env, OPT: JSON.stringify(option), CUR: currency }, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stderr, '', 'no PHP warning or notice')
  return JSON.parse(res.stdout)
}

// The live option's structure with synthetic numbers: the update time is an epoch INTEGER, GBP (the base) has rate and decimals only.
const LIVE_OPTION = {
  exchange_rates_last_update: 1793273765,
  exchange_rates_update_enable: '1',
  exchange_rates_update_schedule: 'twicedaily',
  enabled_currencies: ['EUR', 'GBP', 'NOK', 'USD'],
  exchange_rates: {
    EUR: { rate: '1.150000', rate_markup: '0.01', set_manually: '', exchange_rate_decimals: 4, symbol: 'E' },
    GBP: { rate: '1', decimals: 4 },
    NOK: { rate: '12.250000', rate_markup: '0.10', set_manually: '', decimals: 4 },
    USD: { rate: '1.300000', rate_markup: '', set_manually: '', decimals: 4 },
  },
}

test('plugin EXECUTED (php CLI): an epoch-integer update time becomes ISO UTC; the base row has markup null and set_manually false', { skip: PHP_BIN === null && 'php not installed' }, () => {
  const out = runHandler(LIVE_OPTION) as { ok: boolean; base: string; last_update: string; last_update_source: string; rates: Array<Record<string, unknown>> }
  assert.equal(out.last_update, '2026-10-29T11:36:05Z')
  assert.equal(out.last_update_source, 'exchange_rates_last_update')
  assert.equal(out.base, 'GBP')
  const gbp = out.rates.find((r) => r.currency === 'GBP')
  assert.deepEqual(gbp, { currency: 'GBP', rate: '1', markup: null, set_manually: false, decimals: 4 }, 'the base row: no markup is invented as 0')
  assert.deepEqual(out.rates.find((r) => r.currency === 'EUR'), { currency: 'EUR', rate: '1.150000', markup: '0.01', set_manually: false, decimals: 4 })
  assert.equal(out.rates.find((r) => r.currency === 'USD')?.markup, '', 'an empty markup is returned as Aelia holds it, never combined')
  // a string epoch and an ISO string work too; a non-positive epoch is not a time
  assert.equal((runHandler({ ...LIVE_OPTION, exchange_rates_last_update: '1793273765' }) as { last_update: string }).last_update, '2026-10-29T11:36:05Z')
  assert.equal((runHandler({ ...LIVE_OPTION, exchange_rates_last_update: 0 }) as { last_update: unknown }).last_update, null)
  // CONTROL: a different epoch gives a different time, so the assertion above can fail
  assert.equal((runHandler({ ...LIVE_OPTION, exchange_rates_last_update: 1793273766 }) as { last_update: string }).last_update, '2026-10-29T11:36:06Z')
})

test('plugin EXECUTED (php CLI): a signed push is refused with 410 oti_fx_push_retired and NOTHING is written (every write function is a trap)', { skip: PHP_BIN === null && 'php not installed' }, () => {
  const start = PHP.indexOf("if (!function_exists('oti_handle_fx_push'))")
  const end = PHP.indexOf("if (!function_exists('oti_aelia_last_update_iso'))")
  assert.ok(start > 0 && end > start)
  const traps = ['update_option', 'add_option', 'delete_option', 'set_transient', 'delete_transient', 'wp_cache_flush', 'wp_cache_delete', 'wp_cache_set', 'oti_invalidate_aelia_cache']
  const script = `<?php
class WP_REST_Request { function get_json_params() { return ['rates' => [['fromCurrency' => 'GBP', 'toCurrency' => 'EUR', 'rate' => 1.19]]]; } }
class WP_REST_Response { public $data; function __construct($d) { $this->data = $d; } }
class WP_Error { public $code; public $data; function __construct($c, $m = '', $d = null) { $this->code = $c; $this->data = $d; } }
$writes = [];
${traps.map((t) => `function ${t}(...$a) { global $writes; $writes[] = '${t}'; return true; }`).join('\n')}
${PHP.slice(start, end)}
$r = oti_handle_fx_push(new WP_REST_Request());
echo json_encode(['error' => $r instanceof WP_Error ? $r->code : null, 'status' => $r instanceof WP_Error ? $r->data['status'] : null, 'writes' => $writes]);
`
  const res = spawnSync('php', ['-d', 'display_errors=stderr'], { input: script, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), { error: 'oti_fx_push_retired', status: 410, writes: [] })
  // CONTROL: the traps record, so the empty list above can fail
  const control = spawnSync('php', [], { input: `<?php $writes = []; function update_option(...$a) { global $writes; $writes[] = 'update_option'; } update_option('x', 1); echo json_encode($writes);`, encoding: 'utf8' })
  assert.equal(control.stdout, '["update_option"]')
})

test('plugin source: the plugin no longer hooks any Aelia rate filter, converts a stored rate, or touches Aelia caches', () => {
  const code = PHP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /wc_aelia_currencyswitcher_\w+/, 'no Aelia filter or action is hooked')
  assert.doesNotMatch(code, /oti_resolve_rate|oti_invalidate_aelia_cache|_transient_aelia|reset_settings_cache/)
  // every remaining read of the stored FX options is the read-only table of the settings page
  const reads = [...code.matchAll(/get_option\(OTI_FX_(OPTION|BASE_OPT|LASTPUSH_OPT)/g)]
  assert.equal(reads.length, 3)
  const settings = phpFunction('oti_render_settings_page')
  assert.equal([...settings.matchAll(/get_option\(OTI_FX_(OPTION|BASE_OPT|LASTPUSH_OPT)/g)].length, 3, 'all three reads are in the settings page')
  // CONTROL: the pattern does see a hook when there is one
  assert.match("add_filter('wc_aelia_currencyswitcher_exchange_rate', fn)", /wc_aelia_currencyswitcher_\w+/)
})

test('plugin EXECUTED (php CLI): with oti_fx_rates populated with a DIFFERENT rate, the Aelia exchange-rate filter output equals its input', { skip: PHP_BIN === null && 'php not installed' }, () => {
  const script = `<?php
define('ABSPATH', '/tmp/');
$filters = [];
function add_filter($tag, $cb, $p = 10, $n = 1) { global $filters; $filters[$tag][] = $cb; }
function add_action(...$a) {}
function register_rest_route(...$a) {}
function register_setting(...$a) {}
function add_options_page(...$a) {}
function add_meta_box(...$a) {}
function wp_register_script(...$a) {}
function get_option($k, $d = null) {
  if ($k === 'oti_fx_rates') return ['EUR' => ['from' => 'GBP', 'rate' => 9.87, 'fetchedAt' => 'x']];
  if ($k === 'oti_fx_base_currency') return 'GBP';
  return $d;
}
function apply_filters($tag, $value, ...$args) { global $filters; foreach ($filters[$tag] ?? [] as $cb) { $value = $cb($value, ...$args); } return $value; }
function __($s) { return $s; }
function plugin_dir_path($f) { return ''; }
register_shutdown_function(function () { global $filters; echo "\\n" . json_encode(['out' => apply_filters('wc_aelia_currencyswitcher_exchange_rate', 1.19, 'GBP', 'EUR'), 'hooked' => array_keys($filters)]); });
require getenv('PLUGIN');
`
  const res = spawnSync('php', ['-d', 'display_errors=stderr'], { input: script, env: { ...process.env, PLUGIN: `${process.cwd()}/lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php` }, encoding: 'utf8' })
  const parsed = JSON.parse(res.stdout.slice(res.stdout.indexOf('{"out"'))) as { out: number; hooked: string[] }
  assert.equal(parsed.out, 1.19, 'the filter output is its input: the stored 9.87 is never served')
  assert.equal(parsed.hooked.includes('wc_aelia_currencyswitcher_exchange_rate'), false)
  // CONTROL: a plugin that did hook it would change the output (the harness really applies filters)
  const control = spawnSync('php', [], { input: `<?php $f = []; function add_filter($t, $cb) { global $f; $f[$t][] = $cb; } add_filter('x', fn($v) => 9.87); $v = 1.19; foreach ($f['x'] as $cb) $v = $cb($v); echo $v;`, encoding: 'utf8' })
  assert.equal(control.stdout, '9.87')
})

test('plugin EXECUTED, end to end into the TS parser: the live-shaped answer parses with no refusal and no base entry', { skip: PHP_BIN === null && 'php not installed' }, async () => {
  const { parseAeliaRatesPayload } = await import('@/lib/currencies/aelia-ingest')
  const parsed = parseAeliaRatesPayload(runHandler(LIVE_OPTION), new Date('2026-10-29T12:00:00Z'))
  assert.equal(parsed.updatedAt.getTime(), 1793273765 * 1000)
  assert.deepEqual(parsed.entries.map((e) => e.currency).sort(), ['EUR', 'NOK', 'USD'])
  assert.deepEqual(parsed.refused, [])
  assert.deepEqual(Object.fromEntries(parsed.entries.map((e) => [e.currency, e.markup])), { EUR: '0.01', NOK: '0.10', USD: null })
})
