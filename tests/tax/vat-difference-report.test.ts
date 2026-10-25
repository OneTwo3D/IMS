import assert from 'node:assert/strict'
import test from 'node:test'

import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { DRIFT_MAX_STALENESS_MS } from '@/lib/domain/accounting/tax-rate-drift-status'
import { readWooTaxRateDetails, type WooGetPort, type WooPage, type WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { wooHopRefusal } from '@/lib/reconciliation-pack/woo-transport'
import { VAT_DIFFERENCE_REASON_LIST, compareVatSets, type ImsRateRow, type ImsXeroSnapshot, type VatDifferenceReason } from '@/lib/tax/vat-difference-report'
import { runVatDifferenceReport, type VatRunDb } from '@/lib/tax/vat-difference-run'
import { VAT_DIFF_EXIT_CODES, parseVatDiffArgs, vatDiffExitCode } from '@/lib/tax/vat-difference-cli'
import { WRITER_OWNERSHIP_MAP } from '@/lib/security/writer-ownership-map'
import { runVatDiffCli } from '../../scripts/vat-difference-report'

/**
 * THE VAT DIFFERENCE REPORT (lib/tax/vat-difference-report.ts, vat-difference-run.ts, vat-difference-cli.ts). Pure comparison over fixtures, the
 * trusted-list refusals over an in-memory client, the Woo walk over a fake GET-only port, and the CLI with doubles. Each guard has a
 * `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

const TENANT = 'tenant-1'
const NOW = new Date('2026-10-25T12:00:00Z')
const FETCHED = new Date('2026-10-25T11:30:00Z')

const xeroRow = (taxType: string, pct: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({
  taxType, name: `Xero ${taxType}`, status: 'ACTIVE', reportTaxType: null, effectiveRate: `${pct}.000000`, displayTaxRate: `${pct}.000000`, components: [],
  canApply: { assets: false, equity: false, expenses: taxType.startsWith('INPUT'), liabilities: false, revenue: taxType.startsWith('OUTPUT') }, ...over,
})
const imsRate = (id: string, type: string | null, fraction: string, over: Partial<ImsRateRow> = {}): ImsRateRow => ({
  id, name: `IMS ${id}`, rate: fraction, usedFor: 'SALES', active: true, accountingTaxType: type, countryCode: 'GB', isCompound: false, reverseCharge: false, components: [], ...over,
})
const wooRate = (id: string, rate: string, over: Partial<WooTaxRateDetail> = {}): WooTaxRateDetail => ({
  id, name: `Woo ${id}`, rate, country: 'GB', state: '', postcode: '', city: '', class: 'standard', shipping: true, compound: false, ...over,
})

/** All three systems agree: OUTPUT2 20 and ZERORATEDOUTPUT 0 on sales (mapped to Woo rates 1 and 2), INPUT2 20 on purchases (no storefront rate). */
function baseline(): { snapshot: ImsXeroSnapshot; woo: WooTaxRateDetail[] } {
  return {
    snapshot: {
      xero: { tenantId: TENANT, fetchedAt: FETCHED, rows: [xeroRow('OUTPUT2', '20'), xeroRow('ZERORATEDOUTPUT', '0'), xeroRow('INPUT2', '20')] },
      rates: [imsRate('uk', 'OUTPUT2', '0.2000'), imsRate('zr', 'ZERORATEDOUTPUT', '0.0000'), imsRate('in', 'INPUT2', '0.2000', { usedFor: 'PURCHASE', countryCode: null })],
      mappings: [{ externalTaxRateId: '1', taxRateId: 'uk', externalClass: 'standard' }, { externalTaxRateId: '2', taxRateId: 'zr', externalClass: 'zero-rate' }],
    },
    woo: [wooRate('1', '20.0000'), wooRate('2', '0.0000', { class: 'zero-rate' })],
  }
}
const reasons = (state: { snapshot: ImsXeroSnapshot; woo: WooTaxRateDetail[] }): VatDifferenceReason[] => compareVatSets(state).differences.map((d) => d.reason)

// [mutation: any comparison made to report spuriously, or the empty-case short-circuit removed -> red]
test('all three systems equal -> an empty report, with every reason counted at zero', () => {
  const report = compareVatSets(baseline())
  assert.equal(report.status, 'compared')
  assert.deepEqual(report.differences, [])
  assert.equal(VAT_DIFFERENCE_REASON_LIST.every((reason) => report.counts[reason] === 0), true)
  assert.deepEqual(report.xero, { tenantId: TENANT, fetchedAt: FETCHED.toISOString(), types: 3, active: 3 })
  assert.deepEqual(report.woo, { rates: 2 })
  assert.equal(vatDiffExitCode(report), 0)
})

type Mutate = (s: ReturnType<typeof baseline>) => void
const CASES: Record<VatDifferenceReason, { mutate: Mutate; extra?: VatDifferenceReason[] }> = {
  MISSING_IN_IMS: { mutate: (s) => { s.snapshot.xero.rows.push(xeroRow('OUTPUT3', '5')) } },
  MISSING_IN_XERO: { mutate: (s) => { s.snapshot.rates[0]!.accountingTaxType = 'GONE' }, extra: ['MISSING_IN_IMS'] },
  INACTIVE_IN_XERO: { mutate: (s) => { s.snapshot.xero.rows[0] = xeroRow('OUTPUT2', '20', { status: 'ARCHIVED' }) } },
  IMS_RATE_NO_XERO_TYPE: { mutate: (s) => { s.snapshot.rates.push(imsRate('local', null, '0.0500', { usedFor: 'PURCHASE' })) } },
  AMBIGUOUS_IMS_MAPPING: { mutate: (s) => { s.snapshot.rates.push(imsRate('uk2', 'OUTPUT2', '0.2000', { usedFor: 'BOTH' })) }, extra: ['MISSING_IN_WOO'] },
  XERO_RATE_NOT_STATED: { mutate: (s) => { s.snapshot.xero.rows[0] = xeroRow('OUTPUT2', '20', { effectiveRate: null, displayTaxRate: null }) } },
  PERCENTAGE_MISMATCH_IMS_XERO: { mutate: (s) => { s.snapshot.rates[0]!.rate = '0.1900' } },
  MISSING_IN_WOO: { mutate: (s) => { s.woo.splice(1, 1) }, extra: ['WOO_RATE_GONE'] },
  WOO_RATE_NO_IMS_MAPPING: { mutate: (s) => { s.woo.push(wooRate('9', '20.0000')) } },
  WOO_RATE_GONE: { mutate: (s) => { s.snapshot.mappings.push({ externalTaxRateId: '77', taxRateId: 'uk', externalClass: null }) } },
  WOO_MAPPED_TO_INACTIVE_IMS_RATE: { mutate: (s) => { s.snapshot.rates.push(imsRate('old', 'OUTPUT2', '0.2000', { active: false })); s.snapshot.mappings.push({ externalTaxRateId: '9', taxRateId: 'old', externalClass: null }); s.woo.push(wooRate('9', '20.0000')) } },
  WOO_PERCENTAGE_MISMATCH: { mutate: (s) => { s.woo[0] = wooRate('1', '19.0000') } },
  WOO_COUNTRY_MISMATCH: { mutate: (s) => { s.woo[0] = wooRate('1', '20.0000', { country: 'FR' }) } },
  WOO_CLASS_MISMATCH: { mutate: (s) => { s.woo[0] = wooRate('1', '20.0000', { class: 'reduced-rate' }) } },
  WOO_COMPOUND_MISMATCH: { mutate: (s) => { s.woo[0] = wooRate('1', '20.0000', { compound: true }) } },
  WOO_SHIPPING_NOT_TAXED: { mutate: (s) => { s.woo[0] = wooRate('1', '20.0000', { shipping: false }) } },
  WOO_REGIONAL_SCOPE: { mutate: (s) => { s.woo[0] = wooRate('1', '20.0000', { postcode: 'BT*' }) } },
}

for (const reason of VAT_DIFFERENCE_REASON_LIST) {
  // [mutation: the branch that adds this reason removed from compareVatSets -> this arm red]
  test(`reason ${reason} is reported, with the values on each side, and only with what it implies`, () => {
    const state = baseline()
    CASES[reason].mutate(state)
    const got = reasons(state)
    assert.ok(got.includes(reason), `${reason} reported, got ${got.join(',')}`)
    assert.deepEqual([...new Set(got)].sort(), [reason, ...(CASES[reason].extra ?? [])].sort(), `no other reason than the implied ones for ${reason}`)
  })
}

test('the cases cover every reason code exactly once (a new code needs an arm)', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...VAT_DIFFERENCE_REASON_LIST].sort())
  console.log(`# reason codes: ${VAT_DIFFERENCE_REASON_LIST.length}`)
})

test('a percentage mismatch shows BOTH values; Woo is held to Xero, not to a wrong IMS', () => {
  const s = baseline()
  s.snapshot.rates[0]!.rate = '0.1900'
  s.woo[0] = wooRate('1', '19.0000')
  const report = compareVatSets(s)
  const ims = report.differences.find((d) => d.reason === 'PERCENTAGE_MISMATCH_IMS_XERO')!
  assert.deepEqual([ims.xero, ims.ims], ['20', '19'])
  const woo = report.differences.find((d) => d.reason === 'WOO_PERCENTAGE_MISMATCH')!
  assert.deepEqual([woo.xero, woo.ims, woo.woo], ['20', '19', '19'], 'Woo agrees with IMS but both differ from the master')
})

// [mutation: the country check skipped for a global IMS rate / the class check skipped for a null recorded class -> red]
test('scope is compared both ways, and a null recorded class is the standard class', () => {
  const run = (mut: Mutate) => { const s = baseline(); mut(s); return compareVatSets(s).differences.filter((d) => d.reason === 'WOO_COUNTRY_MISMATCH' || d.reason === 'WOO_CLASS_MISMATCH') }
  // global IMS rate, GB-only Woo rate
  const a = run((s) => { s.snapshot.rates[0]!.countryCode = null })
  assert.deepEqual(a.map((d) => [d.reason, d.ims, d.woo]), [['WOO_COUNTRY_MISMATCH', '(any)', 'GB']])
  // country IMS rate, global Woo rate
  const b = run((s) => { s.woo[0] = wooRate('1', '20.0000', { country: '' }) })
  assert.deepEqual(b.map((d) => [d.reason, d.ims, d.woo]), [['WOO_COUNTRY_MISMATCH', 'GB', '(any)']])
  // both global: equal
  assert.deepEqual(run((s) => { s.snapshot.rates[0]!.countryCode = null; s.woo[0] = wooRate('1', '20.0000', { country: '' }) }), [])
  // null recorded class + live reduced -> difference; + live standard -> none
  const c = run((s) => { s.snapshot.mappings[0]!.externalClass = null; s.woo[0] = wooRate('1', '20.0000', { class: 'reduced-rate' }) })
  assert.deepEqual(c.map((d) => [d.reason, d.ims, d.woo]), [['WOO_CLASS_MISMATCH', 'standard', 'reduced-rate']])
  assert.deepEqual(run((s) => { s.snapshot.mappings[0]!.externalClass = null }), [])
})

test('purchase-only and reverse-charge IMS rates need no storefront rate; a zero rate with shipping off is not a difference', () => {
  const s = baseline()
  s.snapshot.rates.push(imsRate('rc', 'OUTPUT2', '0.2000', { reverseCharge: true, usedFor: 'SALES' }), imsRate('xx', null, '0.0000', { usedFor: 'PURCHASE' }))
  s.snapshot.rates.pop(); s.snapshot.rates.pop()
  s.woo[1] = wooRate('2', '0.0000', { class: 'zero-rate', shipping: false })
  assert.deepEqual(reasons(s), [])
})

// ---- the Xero list must be trusted --------------------------------------------------------------------------

type ClientState = { list: NormalisedXeroTaxRate[] | null; tenant?: string; connected?: string | null; fetchedAt?: Date; stamp?: string | null; writes: string[] }
const decimal = (s: string) => ({ toFixed: (dp?: number) => (dp === undefined ? s : Number(s).toFixed(dp)) })
function client(state: ClientState) {
  const list = state.list
  const tenant = state.tenant ?? TENANT
  const fetchedAt = state.fetchedAt ?? FETCHED
  const base = baseline()
  return {
    accountingToken: { findUnique: async () => (state.connected === null ? null : { tenantId: state.connected ?? TENANT }) },
    xeroTaxRateList: { findMany: async () => (list === null ? [] : [{ connector: 'xero', tenantId: tenant, fetchedAt, rowCount: list.length, digest: digestTaxRateList(tenant, list) }]) },
    xeroTaxRate: {
      findMany: async () => (list ?? []).map((r) => ({
        connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType,
        effectiveRate: r.effectiveRate === null ? null : decimal(r.effectiveRate), displayTaxRate: r.displayTaxRate === null ? null : decimal(r.displayTaxRate),
        components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: r.canApply.equity, canApplyToExpenses: r.canApply.expenses,
        canApplyToLiabilities: r.canApply.liabilities, canApplyToRevenue: r.canApply.revenue,
      })),
    },
    setting: { findUnique: async () => { const stamp = state.stamp === undefined ? fetchedAt.toISOString() : state.stamp; return stamp === null ? null : { value: stamp } } },
    taxRate: { findMany: async () => base.snapshot.rates.map((r) => ({ ...r, rate: decimal(r.rate), components: [] })) },
    shoppingTaxRateMapping: { findMany: async () => base.snapshot.mappings },
    $executeRawUnsafe: async (sql: string) => { state.writes.push(sql); return 0 },
    $queryRawUnsafe: async () => [{ transaction_read_only: 'on' }],
  }
}
function dbFor(state: ClientState, override: Partial<ReturnType<typeof client>> = {}): VatRunDb {
  return { $transaction: async (fn) => fn({ ...client(state), ...override } as never) }
}

/** A fake GET-only port serving `rates` in pages, recording every request. */
function wooPort(rates: Array<Record<string, unknown>>, opts: { fail?: boolean; log?: string[] } = {}): WooGetPort {
  return {
    async get(collection, params): Promise<WooPage> {
      opts.log?.push(`GET ${collection} page=${params.page} per_page=${params.per_page}`)
      if (opts.fail) return { ok: false }
      const perPage = Number(params.per_page)
      const page = Number(params.page)
      const body = rates.slice((page - 1) * perPage, page * perPage)
      return { ok: true, status: 200, total: String(rates.length), totalPages: String(Math.max(1, Math.ceil(rates.length / perPage))), body }
    },
  }
}
const asApi = (r: WooTaxRateDetail) => ({ id: Number(r.id), name: r.name, rate: r.rate, country: r.country, state: r.state, postcode: r.postcode, city: r.city, class: r.class, shipping: r.shipping, compound: r.compound })
const noSleep = { sleep: async () => undefined }
const goodList = () => baseline().snapshot.xero.rows
const run = (state: ClientState, woo: WooGetPort) => runVatDifferenceReport({ db: dbFor(state), now: () => NOW, woo, wooOptions: noSleep })

// [mutation: the readStoredXeroList call replaced by an unchecked findMany -> every refusal arm below red]
test('an untrusted or stale stored Xero list REFUSES the report (never "no differences"), and WooCommerce is not even asked', async () => {
  const log: string[] = []
  const woo = wooPort(baseline().woo.map(asApi), { log })
  const cases: Array<[string, Partial<ClientState>, string]> = [
    ['missing', { list: null }, 'XERO_LIST_MISSING'],
    ['stale', { list: goodList(), fetchedAt: new Date(NOW.getTime() - DRIFT_MAX_STALENESS_MS - 60_000), stamp: new Date(NOW.getTime() - 60_000).toISOString() }, 'XERO_LIST_STALE'],
    ['not stamped', { list: goodList(), stamp: null }, 'XERO_LIST_NOT_STAMPED'],
    ['wrong organisation', { list: goodList(), tenant: 'other' }, 'XERO_LIST_WRONG_ORGANISATION'],
    ['not connected', { list: goodList(), connected: null }, 'XERO_NOT_CONNECTED'],
  ]
  for (const [name, over, code] of cases) {
    const report = await run({ list: goodList(), writes: [], ...over }, woo)
    assert.equal(report.status, 'refused', name)
    assert.equal(report.status === 'refused' && report.code, code, name)
    assert.equal(vatDiffExitCode(report), 2, name)
  }
  assert.deepEqual(log, [], 'no WooCommerce request was made for a refused Xero side')
  // The same fixture with a trusted list compares.
  const ok = await run({ list: goodList(), writes: [] }, woo)
  assert.equal(ok.status, 'compared')
})

// [mutation: a failed Woo walk returns an empty rate list instead of refusing -> red]
test('a WooCommerce read failure (or a list that cannot be proven) REFUSES the report', async () => {
  const failed = await run({ list: goodList(), writes: [] }, wooPort([], { fail: true }))
  assert.equal(failed.status === 'refused' && failed.code, 'WOO_READ_FAILED')
  assert.equal(failed.status === 'refused' && failed.wooReason, 'SOURCE_UNREADABLE')
  // A page that disagrees with the total is not a short list to compare.
  const lying: WooGetPort = { get: async () => ({ ok: true, status: 200, total: '5', totalPages: '1', body: [asApi(wooRate('1', '20.0000'))] }) }
  const unstable = await run({ list: goodList(), writes: [] }, lying)
  assert.equal(unstable.status === 'refused' && unstable.code, 'WOO_READ_FAILED')
  // A store that returns a rate without its boolean flags is unreadable, not repaired.
  const bad = await run({ list: goodList(), writes: [] }, wooPort([{ ...asApi(wooRate('1', '20.0000')), shipping: 'yes' }]))
  assert.equal(bad.status === 'refused' && bad.code, 'WOO_READ_FAILED')
})

test('the IMS read runs in a READ ONLY transaction, and a transaction that is not read-only is not read', async () => {
  const state: ClientState = { list: goodList(), writes: [] }
  const log: string[] = []
  const report = await run(state, wooPort(baseline().woo.map(asApi), { log }))
  assert.equal(report.status, 'compared')
  assert.deepEqual(state.writes, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'])
  const notReadOnly = await runVatDifferenceReport({ db: dbFor({ list: goodList(), writes: [] }, { $queryRawUnsafe: async () => [{ transaction_read_only: 'off' }] }), now: () => NOW, woo: wooPort([]), wooOptions: noSleep })
  assert.equal(notReadOnly.status === 'refused' && notReadOnly.code, 'IMS_UNREADABLE')
})

// ---- Woo pagination ------------------------------------------------------------------------------------------

// [mutation: the walk stops after the first page / the short last page not required -> red]
test('Woo pagination: every page is read (twice, for the proof), a short last page ends the walk, and nothing past it is asked', async () => {
  const rates = ['1', '2', '3', '4', '5'].map((id) => asApi(wooRate(id, '20.0000')))
  const log: string[] = []
  const read = await readWooTaxRateDetails(wooPort(rates, { log }), { ...noSleep, perPage: 2 })
  assert.equal(read.ok && read.value.rates.length, 5)
  assert.deepEqual(log, ['1', '2', '3', '1', '2', '3'].map((p) => `GET taxes page=${p} per_page=2`), 'three pages, read twice, the third (one row) being the end')
  // A store whose second page repeats the first is refused, not deduplicated.
  const repeating: WooGetPort = { get: async () => ({ ok: true, status: 200, total: '4', totalPages: '2', body: [asApi(wooRate('1', '20.0000')), asApi(wooRate('2', '20.0000'))] }) }
  const bad = await readWooTaxRateDetails(repeating, { ...noSleep, perPage: 2 })
  assert.equal(bad.ok, false)
  // The details survive: country, class, flags.
  const one = await readWooTaxRateDetails(wooPort([asApi(wooRate('7', '5.0000', { country: 'IE', class: 'reduced-rate', shipping: false, compound: true }))]), noSleep)
  assert.deepEqual(one.ok && one.value.rates[0], wooRate('7', '5.0000', { country: 'IE', class: 'reduced-rate', shipping: false, compound: true }))
})

// ---- the guard of the shared transport ---------------------------------------------------------------------------

// [mutation: wooHopRefusal's method check removed, or the collection list widened to taxes/classes or any /taxes/<id> -> red]
test('the transport guard the report reads through refuses a non-GET and an off-path request', () => {
  const base = new URL('https://shop.example.com')
  const hop = (url: string, method = 'GET') => wooHopRefusal(base, { method, url: new URL(url), redirectCount: 0 })
  assert.equal(hop('https://shop.example.com/wp-json/wc/v3/taxes?page=1&per_page=100&orderby=id&order=asc&_fields=id,name,rate,country,state,postcode,city,class,shipping,compound'), null)
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(hop('https://shop.example.com/wp-json/wc/v3/taxes', method), 'method')
  assert.equal(hop('https://shop.example.com/wp-json/wc/v3/taxes/12'), 'path')
  assert.equal(hop('https://shop.example.com/wp-json/wc/v3/taxes/classes'), 'path')
  assert.equal(hop('https://shop.example.com/wp-json/wc/v3/settings'), 'path')
  assert.equal(hop('https://evil.example.com/wp-json/wc/v3/taxes'), 'origin')
  assert.equal(hop('https://shop.example.com/wp-json/wc/v3/taxes?force=true'), 'parameter')
})

// ---- the ownership row is pinned ---------------------------------------------------------------------------------

// [mutation: the row removed, or P1/P2 changed -> red]
test('the ownership row woocommerce.tax-rate is pinned: operator-manual at P1, IMS at P2, citing the 2026-10-25 ruling', () => {
  const rows = WRITER_OWNERSHIP_MAP.filter((r) => r.destination === 'woocommerce' && r.operation === 'tax-rate')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.owners.P1, 'operator-manual')
  assert.equal(rows[0]!.owners.P2, 'IMS')
  assert.equal(rows[0]!.owners.P0, 'nobody')
  assert.ok(rows[0]!.note.includes('2026-10-25'))
  assert.equal(rows[0]!.obligationTime, 'not-applicable')
})

// ---- the CLI -----------------------------------------------------------------------------------------------------

test('CLI: argument and environment hardening, exit codes, --json', async () => {
  assert.deepEqual(parseVatDiffArgs(['--json']), { json: true, help: false })
  assert.deepEqual(parseVatDiffArgs(['--bogus']), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parseVatDiffArgs(['--json', '--json']), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parseVatDiffArgs(['postgres://u:p@h/db']), { code: 'CREDENTIAL_ARGUMENT' })
  assert.deepEqual(VAT_DIFF_EXIT_CODES.map((c) => c.code), [0, 1, 2, 3])
  const out: string[] = []
  const err: string[] = []
  let kept: Readonly<Record<string, string>> = {}
  const env = { DATABASE_URL: 'postgres://x', PGPASSWORD: 'leak', PGHOST: 'leak', NODE_OPTIONS: '--require=/tmp/evil.js', SETTINGS_ENCRYPTION_KEY: 'k', XERO_ALLOWED_TENANT_IDS: 'x', PATH: '/bin' }
  const different = baseline()
  different.woo[0] = wooRate('1', '19.0000')
  const common = { env, uid: 0, checkoutOwnerUid: 0, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), onKeptEnv: (k: Readonly<Record<string, string>>) => { kept = k } }
  const deps = (woo: WooGetPort) => ({ now: () => NOW, woo, openDb: async () => ({ db: dbFor({ list: goodList(), writes: [] }), disconnect: async () => undefined }) })
  const code = await runVatDiffCli({ ...common, argv: ['--json'], deps: deps(wooPort(different.woo.map(asApi))) })
  assert.equal(code, 1)
  const parsed = JSON.parse(out.join('\n')) as { status: string; differences: Array<{ reason: string }> }
  assert.deepEqual(parsed.differences.map((d) => d.reason), ['WOO_PERCENTAGE_MISMATCH'])
  assert.deepEqual(Object.keys(kept).sort(), ['DATABASE_URL', 'HOME', 'PATH', 'SETTINGS_ENCRYPTION_KEY'], 'a whitelist: no PG variable, loader variable or Xero guard variable survives')
  out.length = 0
  assert.equal(await runVatDiffCli({ ...common, argv: [], deps: deps(wooPort(baseline().woo.map(asApi))) }), 0)
  assert.match(out.join('\n'), /No differences/)
  assert.equal(await runVatDiffCli({ ...common, argv: [], deps: deps(wooPort([], { fail: true })) }), 2)
  assert.equal(await runVatDiffCli({ ...common, argv: [], uid: 1234, deps: deps(wooPort([])) }), 3)
  assert.equal(await runVatDiffCli({ ...common, argv: [], env: { PATH: '/bin' }, deps: deps(wooPort([])) }), 3)
  assert.equal(await runVatDiffCli({ ...common, argv: ['--help'], deps: deps(wooPort([])) }), 0)
  assert.equal(err.every((line) => !line.includes('leak') && !line.includes('postgres://')), true)
})
