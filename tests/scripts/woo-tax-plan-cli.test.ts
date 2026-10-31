import assert from 'node:assert/strict'
import test from 'node:test'

import { runWooTaxPlanCli, type WooTaxPlanDeps } from '../../scripts/woo-tax-plan.ts'
import {
  WOO_TAX_PLAN_CLI_CODES, WOO_TAX_PLAN_EXIT_CODES, buildWooTaxPlanEnv, type WooTaxPlanRun, parseWooTaxPlanArgs, pickWooHoldEnv, renderWooTaxPlanText, renderWooTaxPlanUsage, wooTaxPlanExitCode,
} from '../../lib/connectors/woocommerce/tax-rate-writer-cli.ts'
import { planWooTaxRates } from '../../lib/connectors/woocommerce/tax-rate-plan.ts'
import type { WooTaxApplyResult, WooTaxHold } from '../../lib/connectors/woocommerce/tax-rate-writer.ts'
import { STORE, consistent, ims, mapOf, woo } from '../helpers/woo-tax-fakes.ts'

/**
 * `npm run woo:tax-plan`: arguments, environment, exit codes and rendering, with the plan and the writer faked. The command is read-only unless --apply; an apply is always given a digest.
 */

const DIGEST = 'a'.repeat(64)
const HELD: WooTaxHold = { mode: 'held', detail: 'held (test)' }

function workPlan() {
  const input = consistent()
  input.woo = input.woo.map((w) => (w.id === '2' ? { ...w, rate: '18.0000' } : w))
  input.mappings = input.mappings.map((m) => (m.externalTaxRateId === '2' ? mapOf(input.woo.find((w) => w.id === '2')!, 'rDE') : m))
  input.rates.push(ims('rFR', { name: 'FR VAT', countryCode: 'FR' }), ims('rOld', { name: 'XX Old', active: false }))
  input.woo.push(woo('9', { name: 'XX Old', country: 'XX' }))
  const mappings = [...input.mappings, { externalTaxRateId: '9', taxRateId: 'rOld', externalName: 'XX Old', externalCountry: 'XX', externalRatePct: '20.0000', externalClass: 'standard', storeIdentity: STORE }]
  return planWooTaxRates({ woo: input.woo, rates: input.rates, mappings, componentRates: [], recordedOwnedWooIds: new Set(), storeIdentity: STORE })
}

test('arguments: exactly --apply with --confirm <64-hex>, --json, --help; anything else is refused with a closed code', () => {
  assert.deepEqual(parseWooTaxPlanArgs([]), { apply: false, confirm: null, adopt: false, json: false, help: false })
  assert.deepEqual(parseWooTaxPlanArgs(['--json']), { apply: false, confirm: null, adopt: false, json: true, help: false })
  assert.deepEqual(parseWooTaxPlanArgs(['--apply', '--confirm', DIGEST]), { apply: true, confirm: DIGEST, adopt: false, json: false, help: false })
  assert.deepEqual(parseWooTaxPlanArgs(['--adopt']), { apply: false, confirm: null, adopt: true, json: false, help: false })
  assert.deepEqual(parseWooTaxPlanArgs(['--adopt', '--apply', '--confirm', DIGEST]), { apply: true, confirm: DIGEST, adopt: true, json: false, help: false })
  assert.deepEqual(parseWooTaxPlanArgs(['--adopt', '--adopt']), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parseWooTaxPlanArgs(['--confirm', DIGEST, '--apply', '--json']), { apply: true, confirm: DIGEST, adopt: false, json: true, help: false })
  for (const bad of [['--apply'], ['--confirm', DIGEST], ['--apply', '--confirm'], ['--apply', '--confirm', 'abc'], ['--apply', '--confirm', DIGEST.toUpperCase()], ['--apply', '--apply', '--confirm', DIGEST],
    ['--apply', '--confirm', DIGEST, '--confirm', DIGEST], ['--force'], ['x']]) {
    assert.deepEqual(parseWooTaxPlanArgs(bad), { code: 'BAD_ARGUMENTS' }, bad.join(' '))
  }
  assert.deepEqual(parseWooTaxPlanArgs(['--token=abc']), { code: 'CREDENTIAL_ARGUMENT' })
  assert.deepEqual(parseWooTaxPlanArgs(['https://user:pw@store.example/']), { code: 'CREDENTIAL_ARGUMENT' })
  assert.equal(Object.keys(WOO_TAX_PLAN_CLI_CODES).length, 5)
})

test('environment: the VAT report whitelist plus ONLY the three hold variables of WooCommerce; nothing else of the caller\'s leaks through', () => {
  const parent = {
    HOME: '/home/x', PATH: '/bin', DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x', SETTINGS_ENCRYPTION_KEY: 'k',
    PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://s.example', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z',
    XERO_WRITE_ALLOWED_TENANT: 'abc', MINTSOFT_WRITE_ALLOWED: 'yes', PGPASSWORD: 'nope', AWS_SECRET_ACCESS_KEY: 'nope',
  }
  assert.deepEqual(pickWooHoldEnv(parent), { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://s.example', WC_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' })
  const kept = buildWooTaxPlanEnv(parent, '/tmp')
  assert.equal(kept.DATABASE_URL, parent.DATABASE_URL)
  assert.equal(kept.PRODUCER_HOLD_ENFORCED_DESTINATIONS, 'woocommerce')
  for (const leak of ['XERO_WRITE_ALLOWED_TENANT', 'MINTSOFT_WRITE_ALLOWED', 'PGPASSWORD', 'AWS_SECRET_ACCESS_KEY']) assert.equal(kept[leak], undefined, leak)
})

test('exit codes: a preview with work is 1, with nothing is 0; a refused apply is 2; a held apply that shadowed is 0; a store refusal is 2', () => {
  const plan = workPlan()
  const empty = planWooTaxRates({ ...consistent(), componentRates: [], recordedOwnedWooIds: new Set(), storeIdentity: STORE })
  const args = { apply: false, confirm: null, adopt: false, json: false, help: false }
  assert.equal(wooTaxPlanExitCode({ args, preview: { hold: HELD, refused: null, plan }, applied: null }), 1)
  assert.equal(wooTaxPlanExitCode({ args, preview: { hold: HELD, refused: null, plan: empty }, applied: null }), 0)
  assert.equal(wooTaxPlanExitCode({ args, preview: { hold: HELD, refused: 'WOO_UNREADABLE', plan: null }, applied: null }), 2)
  const done = (over: Partial<Extract<WooTaxApplyResult, { outcome: 'DONE' }>>): WooTaxApplyResult => ({ outcome: 'DONE', plan, applied: [], shadowed: [], shadowUnrecorded: 0, failed: null, unrecorded: null, ...over })
  const apply = { ...args, apply: true, confirm: DIGEST }
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: { outcome: 'REFUSED', code: 'DIGEST_MISMATCH', plan } }), 2)
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: { outcome: 'NOTHING_TO_DO', plan: empty } }), 0)
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: done({ shadowed: plan.changes.map((c) => c.key) }) }), 0)
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: done({ failed: { key: 'update:2', kind: 'UPDATE', error: 'x' } }) }), 2)
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: done({ unrecorded: { key: 'create:rFR', reason: 'x' } }) }), 2)
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: done({ stopped: { key: 'delete:2', reason: 'MAPPING_REPOINTED: x' } }) }), 2)
  const lost = done({ keeperLost: { key: 'delete:6', keeperWooId: '1', reason: 'the intended keeper (store rate 1) is gone from the store, or could not be read, after the duplicate 6 was deleted' } })
  assert.equal(wooTaxPlanExitCode({ args: apply, preview: null, applied: lost }), 2, 'a keeper lost after the delete is not a success')
  const lostText = renderWooTaxPlanText({ args: apply, preview: null, applied: lost }, HELD)
  assert.match(lostText, /STOPPED AFTER delete:6: the intended keeper \(store rate 1\) is gone from the store/)
  assert.match(lostText, /nothing was recreated/)
  assert.match(renderWooTaxPlanText({ args: apply, preview: null, applied: done({ stopped: { key: 'delete:2', reason: 'MAPPING_REPOINTED: x' } }) }, HELD), /STOPPED at delete:2 BEFORE SENDING IT: MAPPING_REPOINTED/)
  assert.deepEqual(WOO_TAX_PLAN_EXIT_CODES.map((c) => c.code), [0, 1, 2, 3])
})

test('rendering: the preview lists every change with before and after, the digest and the hold; a held apply says NOTHING was sent', () => {
  const plan = workPlan()
  const args = { apply: false, confirm: null, adopt: false, json: false, help: false }
  const text = renderWooTaxPlanText({ args, preview: { hold: HELD, refused: null, plan }, applied: null }, HELD)
  console.log(text)
  assert.match(text, /Changes: CREATE=1 UPDATE=1 DELETE=1/)
  assert.match(text, /UPDATE {2}"DE VAT" \(store rate 2\): rate "18.0000" -> "19.0000"/)
  assert.match(text, /CREATE {2}"FR VAT": FR VAT 20.0000% country FR/)
  assert.match(text, /DELETE {2}"XX Old" \(store rate 9: XX Old 20.0000% XX\): the IMS rate the store rate is mapped to is inactive/)
  assert.ok(text.includes(`Plan digest: ${plan.digest}`))
  assert.match(text, /WooCommerce hold: HELD/)
  const shadow = renderWooTaxPlanText({ args, preview: null, applied: { outcome: 'DONE', plan, applied: [], shadowed: plan.changes.map((c) => c.key), shadowUnrecorded: 0, failed: null, unrecorded: null } }, HELD)
  assert.match(shadow, /SHADOW: 3 change\(s\) recorded as outbound shadows; NOTHING was sent to WooCommerce and no rate or mapping row was written/)
  assert.doesNotMatch(shadow, /Applied: [1-9]/)
  const usage = renderWooTaxPlanUsage()
  for (const word of ['--apply --confirm', 'SHADOWS', 'never touched', 'Exit codes', '--adopt', 'identity']) assert.ok(usage.includes(word), word)
})

function harness(over: Partial<Parameters<typeof runWooTaxPlanCli>[0]> = {}) {
  const out: string[] = []
  const err: string[] = []
  const runs: Array<{ confirm: string | null; holdEnv: Record<string, string> }> = []
  let disconnected = 0
  const plan = workPlan()
  const deps: WooTaxPlanDeps = {
    run: async (input) => {
      runs.push(input)
      return input.confirm === null
        ? { preview: { hold: HELD, refused: null, plan }, applied: null, hold: HELD }
        : { preview: null, applied: { outcome: 'DONE', plan, applied: [], shadowed: plan.changes.map((c) => c.key), shadowUnrecorded: 0, failed: null, unrecorded: null }, hold: HELD }
    },
    disconnect: async () => { disconnected += 1 },
  }
  const options = {
    argv: [] as string[], env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x', PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', HOME: '/tmp' }, uid: 0, checkoutOwnerUid: 1000,
    deps, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), ...over,
  }
  return { options, out, err, runs, disconnected: () => disconnected }
}

test('the command: a preview is read-only (it asks the run for no apply), prints the plan and exits 1 when it lists work', async () => {
  const h = harness()
  const code = await runWooTaxPlanCli(h.options)
  assert.equal(code, 1)
  assert.deepEqual(h.runs, [{ confirm: null, holdEnv: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' } }])
  assert.match(h.out.join('\n'), /Plan digest: [0-9a-f]{64}/)
  assert.equal(h.disconnected(), 1)
})

test('the command: --apply --confirm hands the digest to the run exactly once, and a held apply exits 0 saying nothing was sent', async () => {
  const h = harness({ argv: ['--apply', '--confirm', DIGEST] })
  const code = await runWooTaxPlanCli(h.options)
  assert.equal(code, 0)
  assert.deepEqual(h.runs.map((r) => r.confirm), [DIGEST])
  assert.match(h.out.join('\n'), /NOTHING was sent to WooCommerce/)
})

test('the command: --json prints the hold, the preview and the applied result; --help prints the usage and runs nothing', async () => {
  const j = harness({ argv: ['--json'] })
  assert.equal(await runWooTaxPlanCli(j.options), 1)
  const parsed = JSON.parse(j.out.join('\n')) as { hold: { mode: string }; preview: { plan: { digest: string } }; applied: unknown }
  assert.equal(parsed.hold.mode, 'held')
  assert.match(parsed.preview.plan.digest, /^[0-9a-f]{64}$/)
  assert.equal(parsed.applied, null)
  const help = harness({ argv: ['--help'] })
  assert.equal(await runWooTaxPlanCli(help.options), 0)
  assert.deepEqual(help.runs, [])
  assert.match(help.out.join('\n'), /Usage: npm run woo:tax-plan/)
})

test('the command refuses before any run: bad arguments, an account that is neither root nor the owner, no database; a failing run is an INTERNAL 3', async () => {
  for (const [over, code] of [
    [{ argv: ['--apply'] }, 'BAD_ARGUMENTS'],
    [{ argv: ['--token=x'] }, 'CREDENTIAL_ARGUMENT'],
    [{ uid: 1001 }, 'ACCOUNT_NOT_ALLOWED'],
    [{ env: { HOME: '/tmp' } }, 'DATABASE_URL_MISSING'],
  ] as const) {
    const h = harness(over as Partial<Parameters<typeof runWooTaxPlanCli>[0]>)
    assert.equal(await runWooTaxPlanCli(h.options), 3, code)
    assert.deepEqual(h.runs, [], code)
    assert.match(h.err.join('\n'), new RegExp(`Refused: ${code}`))
  }
  const h = harness()
  h.options.deps = { run: async () => { throw new Error('boom') }, disconnect: async () => undefined }
  assert.equal(await runWooTaxPlanCli(h.options), 3)
  assert.match(h.err.join('\n'), /INTERNAL/)
  assert.ok(!h.err.join('\n').includes('boom'), 'a failure prints a closed code, never the error text')
})

test('the script is registered as npm run woo:tax-plan', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['woo:tax-plan'], 'tsx scripts/woo-tax-plan.ts')
})


test('adoption: --adopt previews the rows it would stamp and exits 1; --adopt --apply --confirm hands the digest to the run as an adoption and exits 0', async () => {
  const rows = [{ wooId: '2', imsRateId: 'rDE', imsRateName: 'DE VAT', reason: 'UNSTAMPED' as const, snapshot: { name: 'DE VAT', country: 'DE', rate: '19.0000', class: 'standard' }, live: { name: 'DE VAT', country: 'DE', rate: '18.0000', class: 'standard' } }]
  const plan = { v: 1 as const, storeIdentity: 'https://store.example', rows, digest: 'b'.repeat(64) }
  const seen: Array<{ confirm: string | null; adopt?: boolean }> = []
  const deps: WooTaxPlanDeps = {
    run: async (input) => {
      seen.push({ confirm: input.confirm, adopt: input.adopt })
      return input.confirm === null
        ? { preview: null, applied: null, adoptionPreview: { refused: null, plan }, hold: HELD }
        : { preview: null, applied: null, adopted: { outcome: 'ADOPTED', plan, adopted: 1 }, hold: HELD }
    },
    disconnect: async () => undefined,
  }
  const out: string[] = []
  const base = { env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 0, checkoutOwnerUid: 1000, deps, stdout: (t: string) => out.push(t), stderr: () => undefined }
  assert.equal(await runWooTaxPlanCli({ ...base, argv: ['--adopt'] }), 1)
  assert.match(out.join('\n'), /Adoption: 1 mapping row\(s\) would be stamped/)
  assert.match(out.join('\n'), /UNSTAMPED {2}"DE VAT" \(store rate 2\): snapshot \[DE VAT 19.0000% DE class standard\] live \[DE VAT 18.0000% DE class standard\]/)
  assert.match(out.join('\n'), /Adoption digest: b{64}/)
  out.length = 0
  assert.equal(await runWooTaxPlanCli({ ...base, argv: ['--adopt', '--apply', '--confirm', DIGEST] }), 0)
  assert.match(out.join('\n'), /Adopted: 1 mapping row\(s\) stamped. Nothing was sent to WooCommerce/)
  assert.deepEqual(seen, [{ confirm: null, adopt: true }, { confirm: DIGEST, adopt: true }])
  const refused: WooTaxPlanRun = { args: parseWooTaxPlanArgs(['--adopt']) as never, preview: null, applied: null, adopted: { outcome: 'REFUSED', code: 'ADOPTION_FAILED', plan } }
  assert.equal(wooTaxPlanExitCode(refused), 2)
  assert.equal(wooTaxPlanExitCode({ ...refused, adopted: null, adoptionPreview: { refused: 'WOO_UNREADABLE', plan: null } }), 2)
  assert.equal(wooTaxPlanExitCode({ ...refused, adopted: null, adoptionPreview: { refused: null, plan: { ...plan, rows: [] } } }), 0)
})
