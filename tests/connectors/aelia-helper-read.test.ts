import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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
  // CONTROL: the same pattern does see the writes of the push handler, so it can fail
  assert.match(phpFunction('oti_handle_fx_push'), writes)
})
