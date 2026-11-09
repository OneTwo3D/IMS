import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { runEuVatPreflightCli } from '../../scripts/eu-vat-preflight.ts'
import { runEuVatSeedCli } from '../../scripts/eu-vat-seed.ts'
import { euVatPreflightExitCode, euVatSeedExitCode, parseEuVatArgs, renderEuVatPreflightText, renderEuVatSeedText, renderEuVatSeedUsage } from '../../lib/tax/eu-vat-cli.ts'
import { evaluateEuVatPreflight, planEuVatSeedApply, type EuVatSeedApplyResult } from '../../lib/tax/eu-vat-preflight.ts'
import { perfectWorld, withWorld } from '../tax/eu-vat-fixtures.ts'

const DIGEST = 'b'.repeat(64)
const ENV = { DATABASE_URL: 'postgresql://scratch.invalid/x', HOME: '/tmp' }
const quiet = () => { const out: string[] = []; const err: string[] = []; return { out, err, stdout: (t: string) => { out.push(t) }, stderr: (t: string) => { err.push(t) } } }
const base = { env: ENV, uid: 0, checkoutOwnerUid: 0 }

test('arguments: the preflight takes only --json and --help; the seed takes --apply with --confirm <64-hex>; anything else is refused with a closed code', () => {
  assert.deepEqual(parseEuVatArgs([], false), { apply: false, confirm: null, json: false, help: false })
  assert.deepEqual(parseEuVatArgs(['--json'], false), { apply: false, confirm: null, json: true, help: false })
  assert.deepEqual(parseEuVatArgs(['--apply'], false), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parseEuVatArgs(['--apply', '--confirm', DIGEST], true), { apply: true, confirm: DIGEST, json: false, help: false })
  for (const bad of [['--apply'], ['--confirm', DIGEST], ['--apply', '--confirm'], ['--apply', '--confirm', 'abc'], ['--apply', '--apply', '--confirm', DIGEST], ['--force'], ['x']]) assert.deepEqual(parseEuVatArgs(bad, true), { code: 'BAD_ARGUMENTS' }, bad.join(' '))
  assert.deepEqual(parseEuVatArgs(['--password=hunter2'], true), { code: 'CREDENTIAL_ARGUMENT' })
})

test('the preflight command: exit 0 ready, 1 findings, 2 refused; never an apply; the output carries codes and figures only', async () => {
  const ready = evaluateEuVatPreflight(perfectWorld().input)
  const broken = evaluateEuVatPreflight(withWorld((w) => { w.mappings.delete(220) }))
  const refused = evaluateEuVatPreflight({ ...perfectWorld().input, xero: { proven: false, reason: 'XERO_LIST_MISSING: none' } })
  for (const [result, code] of [[ready, 0], [broken, 1], [refused, 2]] as const) {
    const io = quiet()
    const exit = await runEuVatPreflightCli({ ...base, argv: [], deps: { run: async () => result, disconnect: async () => undefined }, stdout: io.stdout, stderr: io.stderr })
    assert.equal(exit, code)
    assert.equal(euVatPreflightExitCode(result), code)
    assert.equal(io.err.length, 0)
  }
  assert.match(renderEuVatPreflightText(broken), /WOO_UNMAPPED \[error\]/)
  assert.match(renderEuVatPreflightText(refused), /REFUSED: the stored Xero tax-rate list is not proven/)
  const io = quiet()
  assert.equal(await runEuVatPreflightCli({ ...base, argv: ['--apply', '--confirm', DIGEST], deps: { run: async () => ready, disconnect: async () => undefined }, stdout: io.stdout, stderr: io.stderr }), 3)
  assert.equal(await runEuVatPreflightCli({ ...base, env: {}, argv: [], stdout: io.stdout, stderr: io.stderr }), 3, 'no DATABASE_URL')
  assert.equal(await runEuVatPreflightCli({ ...base, uid: 1234, argv: [], stdout: io.stdout, stderr: io.stderr }), 3, 'not root or the owner')
})

test('the seed command is a DRY RUN by default: it is never handed a digest and says what to run to apply', async () => {
  const plan = planEuVatSeedApply(withWorld((w) => { for (const [id, r] of w.ims) w.ims.set(id, { ...r, schemePostingTaxType: null, reportingCategory: null }) }))
  const seen: Array<{ apply: boolean; confirm: string | null }> = []
  const io = quiet()
  const exit = await runEuVatSeedCli({ ...base, argv: [], deps: { run: async (o) => { seen.push(o); return { applied: false, plan, refusal: null } }, disconnect: async () => undefined }, stdout: io.stdout, stderr: io.stderr })
  assert.equal(exit, 1)
  assert.deepEqual(seen, [{ apply: false, confirm: null }])
  assert.match(io.out.join('\n'), /DRY RUN: nothing was written\. To apply exactly this plan: npm run eu-vat:seed -- --apply --confirm [0-9a-f]{64}/)
})

test('the seed command applies only with --apply --confirm <digest>, hands the digest through, and maps outcomes to exit codes', async () => {
  const plan = planEuVatSeedApply(perfectWorld().input)
  const seen: Array<{ apply: boolean; confirm: string | null }> = []
  const outcomes: Array<[EuVatSeedApplyResult, number]> = [
    [{ applied: true, plan, written: 30 }, 0],
    [{ applied: false, plan, refusal: { code: 'DIGEST_MISMATCH', detail: 'x' } }, 2],
    [{ applied: false, plan, refusal: { code: 'NOTHING_TO_APPLY', detail: 'x' } }, 0],
    [{ applied: false, plan, refusal: null }, 0],
  ]
  for (const [result, code] of outcomes) {
    const io = quiet()
    assert.equal(await runEuVatSeedCli({ ...base, argv: ['--apply', '--confirm', DIGEST], deps: { run: async (o) => { seen.push(o); return result }, disconnect: async () => undefined }, stdout: io.stdout, stderr: io.stderr }), code)
    assert.equal(euVatSeedExitCode(result), code)
  }
  assert.deepEqual(seen.map((s) => s.confirm), [DIGEST, DIGEST, DIGEST, DIGEST])
  assert.ok(seen.every((s) => s.apply))
  const io = quiet()
  assert.equal(await runEuVatSeedCli({ ...base, argv: ['--apply'], stdout: io.stdout, stderr: io.stderr }), 3, '--apply alone is refused: the apply needs the digest of the dry run')
  assert.match(renderEuVatSeedText({ applied: false, plan, refusal: { code: 'DIGEST_MISMATCH', detail: 'the plan changed' } }, true), /Nothing was written\./)
  assert.match(renderEuVatSeedUsage(), /DRY RUN unless --apply --confirm/)
})

test('nothing in the preflight, the seed or their commands can reach Xero, WooCommerce or a network: a source scan', () => {
  const files = ['lib/tax/eu-vat-seed.ts', 'lib/tax/eu-vat-preflight.ts', 'lib/tax/eu-vat-cli.ts', 'scripts/eu-vat-preflight.ts', 'scripts/eu-vat-seed.ts', 'lib/connectors/xero/scheme-posting-drift.ts', 'lib/domain/accounting/eu-vat-settings.ts']
  const bareFetch = /\bfetch\s*\(|wcFetch|xeroFetch|node:https?|node:net\b|axios|undici/
  // Xero: the pure list shape, the report-type helper and the connection read. WooCommerce: only the stored-settings reader and the pure URL normaliser (no request is made by either).
  const allowedImports: Record<string, Set<string>> = { xero: new Set(['tax-rate-list', 'tax-rate-report-type', 'connection-fence']), woocommerce: new Set(['api', 'tax-rate-plan']) }
  for (const file of files) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, bareFetch, `${file} makes no request`)
    for (const m of source.matchAll(/from ['"](?:@\/lib|\.\.\/lib|\.)\/connectors\/(xero|woocommerce|mintsoft)\/([\w-]+)['"]|import\(['"](?:@\/lib|\.\.\/lib)\/connectors\/(xero|woocommerce|mintsoft)\/([\w-]+)(?:\.ts)?['"]\)/g)) {
      const connector = m[1] ?? m[3]
      const imported = m[2] ?? m[4]
      assert.ok(allowedImports[connector!]?.has(imported!) === true, `${file} imports connectors/${connector}/${imported}`)
    }
    assert.doesNotMatch(source, /(?:tx|db|client)\.(?:xeroTaxRate|xeroTaxRateList|accountingSyncLog|accountingEvent|shoppingTaxRateMapping)\.(?:create|update|upsert|delete)/, `${file} writes no mapping, no Xero cache and no ledger row`)
  }
})

test('the commands are registered in package.json, the seed file is the one the CLI loads, and the apply writes only the two declared columns', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
  assert.equal(pkg.scripts['eu-vat:preflight'], 'tsx scripts/eu-vat-preflight.ts')
  assert.equal(pkg.scripts['eu-vat:seed'], 'tsx scripts/eu-vat-seed.ts')
  const source = readFileSync(new URL('../../lib/tax/eu-vat-preflight.ts', import.meta.url), 'utf8')
  const writes = [...source.matchAll(/\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1])
  assert.deepEqual(writes, ['updateMany'], 'the only write in the module is the compare-and-set of the apply')
  assert.match(source, /data: \{ schemePostingTaxType: change\.to\.schemePostingTaxType, reportingCategory: change\.to\.reportingCategory \}/)
})
