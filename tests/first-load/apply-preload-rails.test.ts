import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  APPLY_CHECK_COVERAGE, APPLY_CHECK_RAILS, PRECONDITION_IDS, PRELOAD_RAIL_IDS, RAIL_IDS,
} from '../../lib/first-load/apply/constants.ts'
import { APPLY_TIME_CHECKS } from '../../lib/first-load/spec.ts'
import { buildPreconditions } from '../../lib/first-load/apply/report.ts'
import {
  READ_ONLY_CRON_SLUGS, classifyCrontabText, connectorFinding, cronFinding, evaluatePreloadRails, outboundGrantFinding, producerHoldFinding,
  type ConnectorSnapshot, type PreloadReaders,
} from '../../lib/first-load/apply/db/preload-rails.ts'
import { CLEAN_SNAPSHOT } from './apply-preload.ts'
import { precondition } from './helpers.ts'

/**
 * THE PRE-LOAD RAILS, pure arms (the database reader and the whole load are in apply-db.test.ts). Each arm names the change that turns it red. A grant, a connector, a cron line and a producer-hold
 * state are values from the installation: the text a rail prints names a rail, a closed connector label and a count, never the value (POISON below proves it).
 */

const POISON = 'POISON-https://secret.example.test/x'
const WOO = 'https://shop.example.test'
const MINTSOFT = 'https://api.example.test|89'
const XERO = '11111111-2222-3333-4444-555555555555'
const CUTOFF = '2026-10-30T00:00:00Z'

test('outbound grants: none is clean; any one, in any destination, refuses; an unreadable one refuses too [mutation: treat unreadable as absent / ignore a destination]', (t) => {
  assert.deepEqual(outboundGrantFinding({}).problems, [])
  const arms: Array<[string, Record<string, string>, RegExp]> = [
    ['WooCommerce granted', { WC_WRITEBACK_ALLOWED_ORIGIN: WOO }, /WooCommerce is present|for WooCommerce is present/],
    ['Mintsoft granted', { MINTSOFT_WRITE_ALLOWED: MINTSOFT }, /for Mintsoft is present/],
    ['Xero granted', { XERO_WRITE_ALLOWED_TENANT: XERO }, /for Xero is present/],
    ['WooCommerce unreadable (a list)', { WC_WRITEBACK_ALLOWED_ORIGIN: `${WOO},https://other.example.test` }, /for WooCommerce is set but cannot be read/],
    ['Mintsoft unreadable', { MINTSOFT_WRITE_ALLOWED: `${POISON}|x` }, /for Mintsoft is set but cannot be read/],
    ['Xero unreadable (a flag)', { XERO_WRITE_ALLOWED_TENANT: 'true' }, /for Xero is set but cannot be read/],
  ]
  precondition(t, 'grant arms', arms.length)
  for (const [label, env, expected] of arms) {
    const found = outboundGrantFinding(env)
    assert.equal(found.problems.length, 1, label)
    assert.match(found.problems[0]!, expected, label)
    assert.ok(!found.problems.join(' ').includes('shop.example') && !found.problems.join(' ').includes('POISON') && !found.problems.join(' ').includes(XERO), `${label}: no value in the text`)
  }
  assert.equal(outboundGrantFinding({ WC_WRITEBACK_ALLOWED_ORIGIN: WOO, MINTSOFT_WRITE_ALLOWED: MINTSOFT, XERO_WRITE_ALLOWED_TENANT: XERO }).problems.length, 3)
})

test('producer hold: the state is reported; a live-from instant, a disagreement or an unreadable value refuses [mutation: drop the cutoff check]', (t) => {
  const off = producerHoldFinding({})
  assert.deepEqual(off.problems, [])
  assert.match(off.detail, /enforcement OFF \(the default\); 3 of 3 destination\(s\) agreed held/)
  const on = producerHoldFinding({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero,mintsoft' })
  assert.deepEqual(on.problems, [])
  assert.match(on.detail, /enforcement ON for 2 destination\(s\); 3 of 3/)
  const arms: Array<[string, Record<string, string>, RegExp]> = [
    ['enforcement unreadable', { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'everything' }, /enforcement variable is set but cannot be read/],
    ['a live-from instant with no grant (Xero)', { XERO_WRITES_LIVE_FROM: CUTOFF }, /live-from instant is set for Xero/],
    ['a live-from instant that cannot be read', { MINTSOFT_WRITES_LIVE_FROM: 'next week' }, /live-from variable for Mintsoft is set but cannot be read/],
    ['a grant with no live-from instant', { WC_WRITEBACK_ALLOWED_ORIGIN: WOO }, /grant and the live-from instant for WooCommerce disagree/],
    ['a grant and an instant (live)', { XERO_WRITE_ALLOWED_TENANT: XERO, XERO_WRITES_LIVE_FROM: CUTOFF }, /live-from instant is set for Xero/],
  ]
  precondition(t, 'producer arms', arms.length)
  for (const [label, env, expected] of arms) {
    const found = producerHoldFinding(env)
    assert.ok(found.problems.length >= 1, label)
    assert.match(found.problems.join(' | '), expected, label)
    assert.ok(!found.problems.join(' ').includes(CUTOFF) && !found.problems.join(' ').includes('next week'), `${label}: no value in the text`)
  }
  // The producer-hold variable names ON and OFF alike are reported, never refused for themselves.
  assert.deepEqual(producerHoldFinding({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }).problems, [])
})

test('connectors: enabled with a credential that could write refuses; enabled without one, or a credential with the connector off, does not [mutation: ignore the enabled flag / a destination]', (t) => {
  const snapshot = (over: Partial<ConnectorSnapshot>): ConnectorSnapshot => ({ ...CLEAN_SNAPSHOT, ...over })
  const enabled = (id: 'woocommerce' | 'mintsoft' | 'xero') => ({ pluginEnabled: { ...CLEAN_SNAPSHOT.pluginEnabled, [id]: true } })
  const store = { wc_url: true, wc_consumer_key: true, wc_consumer_secret: true }
  assert.deepEqual(connectorFinding(CLEAN_SNAPSHOT).problems, [])
  const refused: Array<[string, ConnectorSnapshot, RegExp]> = [
    ['storefront enabled with URL and keys', snapshot({ ...enabled('woocommerce'), credentialPresent: store }), /WooCommerce connector is enabled with store credentials/],
    ['warehouse connector enabled with an API key', snapshot({ ...enabled('mintsoft'), credentialPresent: { mintsoft_api_key: true } }), /Mintsoft connector is enabled with a credential/],
    ['warehouse connector enabled with a static key', snapshot({ ...enabled('mintsoft'), credentialPresent: { mintsoft_static_api_key: true } }), /Mintsoft connector is enabled/],
    ['warehouse connector enabled with a username and password', snapshot({ ...enabled('mintsoft'), credentialPresent: { mintsoft_username: true, mintsoft_password: true } }), /Mintsoft connector is enabled/],
    ['warehouse connector enabled with an active connection and no credential', snapshot({ ...enabled('mintsoft'), activeWarehouseConnections: 1 }), /no credential, 1 active connection/],
    ['warehouse connector enabled with an active binding', snapshot({ ...enabled('mintsoft'), activeWarehouseBindings: 2 }), /2 active warehouse binding/],
    ['accounting connector enabled with a stored token', snapshot({ ...enabled('xero'), accountingTokens: 1 }), /Xero connector is enabled with 1 stored token/],
    ['accounting connector enabled with a client secret', snapshot({ ...enabled('xero'), credentialPresent: { xero_client_secret: true } }), /Xero connector is enabled/],
  ]
  precondition(t, 'refused arms', refused.length)
  for (const [label, snap, expected] of refused) {
    const found = connectorFinding(snap)
    assert.equal(found.problems.length, 1, label)
    assert.match(found.problems[0]!, expected, label)
  }
  const quiet: Array<[string, ConnectorSnapshot]> = [
    ['storefront enabled with only a URL', snapshot({ ...enabled('woocommerce'), credentialPresent: { wc_url: true, wc_consumer_key: true } })],
    ['storefront credentials but the connector off', snapshot({ credentialPresent: store })],
    ['warehouse credentials, connection and binding but the connector off', snapshot({ credentialPresent: { mintsoft_api_key: true }, activeWarehouseConnections: 3, activeWarehouseBindings: 3 })],
    ['accounting token but the connector off', snapshot({ accountingTokens: 5, credentialPresent: { xero_client_secret: true } })],
    ['warehouse connector enabled and nothing configured', snapshot(enabled('mintsoft'))],
    ['accounting connector enabled and nothing configured', snapshot(enabled('xero'))],
  ]
  precondition(t, 'quiet arms', quiet.length)
  for (const [label, snap] of quiet) assert.deepEqual(connectorFinding(snap).problems, [], label)
})

test('crons: only active lines that call the application count; a read-only job is allowed; an unclassifiable line or an unreadable crontab refuses [mutation: count comments / allow every slug]', (t) => {
  const managed = (slug: string) => `*/5 * * * *  CRON_SECRET=$(grep -m1 '^CRON_SECRET=' '/x/.env' | cut -d= -f2- | tr -d '"'); case "$CRON_SECRET" in '') echo no ;; *) echo "header = \\"Authorization: Bearer $CRON_SECRET\\"" | curl -sf -o /dev/null -K - "$BASE_URL/${slug}" ;; esac >> '/l' 2>&1`
  const legacy = (slug: string) => `0 * * * *  curl -sf -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${slug}" >> /l 2>&1`
  const direct = (slug: string) => `0 * * * * curl -s https://ims.example.test/api/cron/${slug}`
  assert.deepEqual(classifyCrontabText(''), { allowed: 0, writers: 0, unclassified: 0 })
  assert.deepEqual(classifyCrontabText(['# --- OTI CRON START ---', '# Managed by One Two Inventory', 'BASE_URL="http://x/api/cron"', '# accounting-sync', `# ${managed('accounting-sync')}`, '', '# --- OTI CRON END ---', 'MAILTO=ops@example.test', '0 3 * * * /usr/local/bin/other-job'].join('\n')), { allowed: 0, writers: 0, unclassified: 0 })
  const cases: Array<[string, string, { allowed: number; writers: number; unclassified: number }]> = [
    ['a managed accounting job', managed('accounting-sync'), { allowed: 0, writers: 1, unclassified: 0 }],
    ['a legacy bearer-on-the-command-line job', legacy('mintsoft-stock-sync'), { allowed: 0, writers: 1, unclassified: 0 }],
    ['a hand-written call to /api/cron/', direct('wc-reconcile'), { allowed: 0, writers: 1, unclassified: 0 }],
    ['a read-only job (backup)', managed('backup'), { allowed: 1, writers: 0, unclassified: 0 }],
    ['a read-only job (writers-check, legacy)', legacy('writers-check'), { allowed: 1, writers: 0, unclassified: 0 }],
    ['a managed job whose slug cannot be read', 'case x in *) curl -sf -K - "$BASE_URL/" ;; esac', { allowed: 0, writers: 0, unclassified: 1 }],
    ['two writers and a read-only one', [managed('invariant-check'), legacy('accounting-sync'), direct('backup')].join('\n'), { allowed: 1, writers: 2, unclassified: 0 }],
  ]
  precondition(t, 'cron arms', cases.length)
  for (const [label, text, expected] of cases) assert.deepEqual(classifyCrontabText(text), expected, label)
  assert.deepEqual(cronFinding({ resolved: true, text: '' }).problems, [])
  assert.deepEqual(cronFinding({ resolved: true, text: managed('backup') }).problems, [])
  assert.match(cronFinding({ resolved: true, text: managed('accounting-sync') }).problems.join(' '), /1 active scheduled-job line\(s\) in the crontab could write/)
  assert.match(cronFinding({ resolved: true, text: 'case x in *) curl -K - "$BASE_URL/" ;; esac' }).problems.join(' '), /name no job this check can classify/)
  const unreadable = cronFinding({ resolved: false })
  assert.equal(unreadable.problems.length, 1)
  assert.match(unreadable.problems[0]!, /an unreadable crontab is not an empty one/)
})

test('every read-only cron slug is a registered job, and every other registered job is treated as a writer', async (t) => {
  await import('@/lib/cron-jobs')
  const { getAllCronJobs } = await import('@/lib/cron-registry')
  const slugs = getAllCronJobs().map((job) => job.slug)
  precondition(t, 'registered jobs', slugs.length)
  for (const slug of READ_ONLY_CRON_SLUGS) assert.ok(slugs.includes(slug), `${slug} is registered`)
  const writers = slugs.filter((slug) => !READ_ONLY_CRON_SLUGS.includes(slug))
  precondition(t, 'jobs treated as writers', writers.length)
  for (const slug of writers) assert.equal(classifyCrontabText(`* * * * * curl -sf -K - "$BASE_URL/${slug}"`).writers, 1, slug)
})

test('evaluatePreloadRails: a reader that throws is not "fine" (connectors propagate the refusal; the crontab becomes unresolved)', async () => {
  const readers = (over: Partial<PreloadReaders> = {}): PreloadReaders => ({ env: {}, connectors: async () => CLEAN_SNAPSHOT, crontab: async () => ({ resolved: true, text: '' }), ...over })
  const clean = await evaluatePreloadRails(readers())
  assert.deepEqual(clean.map((f) => f.rail), [...PRELOAD_RAIL_IDS].sort((a, b) => PRELOAD_RAIL_IDS.indexOf(a) - PRELOAD_RAIL_IDS.indexOf(b)))
  assert.deepEqual(clean.flatMap((f) => f.problems), [])
  await assert.rejects(evaluatePreloadRails(readers({ connectors: async () => { throw new Error('connection reset') } })), /connection reset/)
  const noCrontab = await evaluatePreloadRails(readers({ crontab: async () => { throw new Error('spawn crontab ENOENT') } }))
  assert.match(noCrontab.flatMap((f) => f.problems).join(' '), /crontab of the account running the load could not be read/)
  const everything = await evaluatePreloadRails(readers({ env: { WC_WRITEBACK_ALLOWED_ORIGIN: WOO } }))
  assert.equal(everything.filter((f) => f.problems.length > 0).map((f) => f.rail).join(','), 'outbound-grants,producer-hold', 'the grant is seen by BOTH the grant rail and the producer-hold agreement')
})

test('the rails are the same everywhere: RAIL_IDS, the ids of an evaluation, the check table and the precondition ids agree [mutation: add a rail to one list only]', (t) => {
  const checkIds = APPLY_TIME_CHECKS.map((c) => c.id).sort()
  precondition(t, 'apply-time checks', checkIds.length)
  assert.deepEqual(Object.keys(APPLY_CHECK_RAILS).sort(), checkIds, 'every apply-time check says which rails prove it')
  assert.deepEqual(Object.keys(APPLY_CHECK_COVERAGE).sort(), checkIds)
  for (const [id, rails] of Object.entries(APPLY_CHECK_RAILS)) {
    if (rails === null) assert.equal(APPLY_CHECK_COVERAGE[id]!.status, 'not-applicable', id)
    else for (const rail of rails) assert.ok((RAIL_IDS as readonly string[]).includes(rail), `${id} names a real rail`)
  }
  assert.deepEqual(PRECONDITION_IDS, [...RAIL_IDS.map((r) => `rail:${r}`), ...checkIds.map((c) => `check:${c}`)])
  assert.equal(new Set(PRECONDITION_IDS).size, PRECONDITION_IDS.length)
  for (const id of PRELOAD_RAIL_IDS) assert.ok((RAIL_IDS as readonly string[]).includes(id))
})

test('preconditions[]: every id, always in order; a rail that refused once is refused; checks follow their rails [mutation: take the last evaluation / drop a check]', (t) => {
  assert.deepEqual(buildPreconditions([]), [], 'no rail evaluated: none')
  const tally = (over: Record<string, { evaluations: number; refusals: number; detail?: string }> = {}) =>
    RAIL_IDS.filter((id) => !['fx-rates', 'tax-rates', 'warehouses', 'forbidden-skus', 'currency-lock'].includes(id) || over[id]).map((id) => ({ id: id as string, evaluations: over[id]?.evaluations ?? 3, refusals: over[id]?.refusals ?? 0, detail: over[id]?.detail ?? '' }))
  const clean = buildPreconditions(tally())
  precondition(t, 'precondition entries', clean.length)
  assert.deepEqual(clean.map((p) => p.id), PRECONDITION_IDS)
  assert.equal(clean.find((p) => p.id === 'rail:fx-rates')!.result, 'not-applicable')
  assert.equal(clean.find((p) => p.id === 'check:po-fx-rate')!.result, 'not-applicable', 'a check whose only rail did not apply')
  assert.equal(clean.find((p) => p.id === 'check:transfer-reference-free')!.result, 'not-applicable')
  assert.equal(clean.find((p) => p.id === 'check:product-parent-exists')!.result, 'pass', 'proved by the files')
  assert.equal(clean.find((p) => p.id === 'check:barcode-free')!.result, 'pass')
  assert.equal(clean.filter((p) => p.result === 'refused').length, 0)
  const refusedOnce = buildPreconditions(tally({ crons: { evaluations: 4, refusals: 1 }, 'data-classes': { evaluations: 4, refusals: 2 } }))
  assert.equal(refusedOnce.find((p) => p.id === 'rail:crons')!.result, 'refused')
  assert.match(refusedOnce.find((p) => p.id === 'rail:crons')!.detail, /refused in 1 of 4 evaluation/)
  for (const id of ['check:barcode-free', 'check:opening-stock-empty', 'check:po-reference-free', 'check:po-product-lifecycle', 'check:lookup-keys-unique-in-ims']) assert.equal(refusedOnce.find((p) => p.id === id)!.result, 'refused', id)
  assert.equal(refusedOnce.find((p) => p.id === 'check:base-currency')!.result, 'pass', 'a check is refused only by its own rails')
  assert.match(clean.find((p) => p.id === 'rail:producer-hold')!.detail, /\(3 evaluation\(s\)\)/)
})

test('the pre-load module reads nothing it should not: no write, no network, no credential in text (absence over the file)', (t) => {
  const text = readFileSync(path.join(process.cwd(), 'lib/first-load/apply/db/preload-rails.ts'), 'utf8')
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const forbidden: Array<[string, RegExp]> = [
    ['a database write', /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i],
    ['a network call', /\bfetch\s*\(|node:(?:net|http|https)|connectorFetch/],
    ['a crontab write', /crontab['"],\s*\[\s*['"]-['"]|\bspawn\(/],
    ['a value in a message', /\$\{(?:env|settings|stored|line|raw)\b/],
  ]
  precondition(t, 'forbidden shapes', forbidden.length)
  for (const [what, pattern] of forbidden) assert.doesNotMatch(code, pattern, what)
  assert.match("await db.setting.update({})", forbidden[0]![1], 'control: the write pattern can fail')
  assert.match("await fetch(url)", forbidden[1]![1], 'control: the network pattern can fail')
  assert.match("spawn('crontab', ['-'])", forbidden[2]![1], 'control: the crontab-write pattern can fail')
})
