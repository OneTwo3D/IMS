import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { ComparableInvoice } from '../../lib/domain/accounting/eu-vat-shadow-compare'
import { parseEuVatShadowArgs, renderEuVatShadowText, euVatShadowJson, renderEuVatShadowUsage } from '../../lib/tax/eu-vat-shadow-cli'
import { runEuVatShadow, shadowExitCode, SHADOW_HARD_MAX_ORDERS, type ShadowImsBuild, type ShadowPorts, type ShadowXeroFetch } from '../../lib/tax/eu-vat-shadow-run'
import { closedCodeOf } from '../../lib/tax/eu-vat-shadow-live'
import { runEuVatShadowCli } from '../../scripts/eu-vat-shadow-report'

/**
 * THE SHADOW RUN OVER INJECTED PORTS: no database, no WooCommerce, no Xero. The fakes hold invented figures and, deliberately, invented personal data that must never reach the output.
 */
const PII = ['Jane Private', 'jane@example.invalid', '1 Secret Street']

const invoice = (vatAmount = '20.24'): ComparableInvoice => ({
  currency: 'EUR', lineAmountsIncludeTax: false, total: '126.74',
  lines: [
    { kind: 'goods', accountCode: '200', taxType: 'TAX131', lineAmount: '106.50', taxAmount: '0.00' },
    { kind: 'vat', accountCode: '821', taxType: 'NONE', lineAmount: vatAmount, taxAmount: '0.00' },
  ],
})
const xeroFor = (vatAmount = '20.24', total = 126.74) => ({
  InvoiceNumber: 'INV-1', Status: 'AUTHORISED', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', Total: total,
  Contact: { Name: PII[0], EmailAddress: PII[1] },
  LineItems: [
    { Description: PII[2], AccountCode: '200', TaxType: 'TAX131', LineAmount: 106.5, TaxAmount: 0 },
    { AccountCode: '821', TaxType: 'NONE', LineAmount: Number(vatAmount), TaxAmount: 0 },
  ],
})

type Scenario = { destination?: string | null; invoiceNumber?: string | null; ims?: ShadowImsBuild; xero?: ShadowXeroFetch; wcFails?: boolean }

function ports(scenarios: Record<string, Scenario>, calls: { xero: string[]; build: string[]; load: string[]; list: Array<number> } = { xero: [], build: [], load: [], list: [] }): ShadowPorts {
  const refs = Object.keys(scenarios).map((number) => ({ orderId: `id-${number}`, orderNumber: number, externalOrderId: number }))
  return {
    async listOrders(_selection, limit) { calls.list.push(limit); return { refs: refs.slice(0, limit), unresolved: [] } },
    async loadWcOrder(ref) {
      calls.load.push(ref.orderNumber)
      const s = scenarios[ref.orderNumber]!
      if (s.wcFails) return { ok: false, code: 'http_404' }
      return { ok: true, wc: { destination: s.destination === undefined ? 'DE' : s.destination, invoiceNumber: s.invoiceNumber === undefined ? `INV-${ref.orderNumber}` : s.invoiceNumber, order: { billing: { first_name: PII[0], email: PII[1], address_1: PII[2] } } } }
    },
    async buildIms(ref) { calls.build.push(ref.orderNumber); return scenarios[ref.orderNumber]!.ims ?? { kind: 'built', invoice: invoice(), warnings: [], stampSource: 'provisional', route: 'scheme', regime: 'IOSS' } },
    async fetchXeroInvoice(number) { calls.xero.push(number); const n = number.replace('INV-', ''); return scenarios[n]?.xero ?? { kind: 'found', invoice: xeroFor() } },
  }
}

test('every outcome is classified: match, differs, review (boundary), no Xero doc, IMS refused (with the reason), not comparable', async () => {
  const boundary: ShadowImsBuild = { kind: 'built', invoice: invoice(), warnings: [{ code: 'threshold_band' }], stampSource: 'provisional', route: 'scheme', regime: 'IOSS' }
  const report = await runEuVatShadow(ports({
    '1001': {},
    '1002': { xero: { kind: 'found', invoice: xeroFor('20.25', 126.75) } },
    '1003': { ims: boundary, xero: { kind: 'found', invoice: xeroFor('20.25', 126.75) } },
    '1004': { ims: boundary },
    '1005': { xero: { kind: 'none' } },
    '1006': { ims: { kind: 'refused', reason: 'the order carries store credit, and IMS refuses a store-credit invoice whole' } },
    '1007': { xero: { kind: 'ambiguous', count: 2 } },
    '1008': { xero: { kind: 'error', code: 'http_429' } },
    '1009': { invoiceNumber: null },
    '1010': { wcFails: true },
    '1011': { xero: { kind: 'found', invoice: { ...xeroFor(), Status: 'VOIDED' } } },
  }), { selection: { kind: 'orders', refs: ['x'] }, maxOrders: 50 })
  const by = Object.fromEntries(report.results.map((r) => [r.orderNumber, r.status]))
  assert.deepEqual(by, { '1001': 'match', '1002': 'differs', '1003': 'review', '1004': 'match', '1005': 'no_xero_doc', '1006': 'ims_refused', '1007': 'not_comparable', '1008': 'not_comparable', '1009': 'not_comparable', '1010': 'not_comparable', '1011': 'no_xero_doc' })
  assert.deepEqual(report.counts, { match: 2, differs: 1, review: 1, no_xero_doc: 2, ims_refused: 1, not_comparable: 4 })
  assert.equal(report.results.find((r) => r.orderNumber === '1006')?.detail, 'the order carries store credit, and IMS refuses a store-credit invoice whole')
  assert.equal(shadowExitCode(report), 1)
})

test('exit 0 only when everything matches; a review order, a truncated selection or an unresolved reference is not clean', async () => {
  const clean = await runEuVatShadow(ports({ '1': {}, '2': {} }), { selection: { kind: 'orders', refs: ['1', '2'] }, maxOrders: 10 })
  assert.equal(shadowExitCode(clean), 0)
  const cut = await runEuVatShadow(ports({ '1': {}, '2': {}, '3': {} }), { selection: { kind: 'range', from: '2026-11-01', to: '2026-11-02' }, maxOrders: 2 })
  assert.equal(cut.truncated, true)
  assert.equal(cut.results.length, 2)
  assert.equal(shadowExitCode(cut), 1)
})

test('a non-EU destination is skipped before anything is built or fetched', async () => {
  const calls = { xero: [] as string[], build: [] as string[], load: [] as string[], list: [] as number[] }
  const report = await runEuVatShadow(ports({ '1': { destination: 'GB' }, '2': { destination: 'DE' }, '3': { destination: 'NO' }, '4': { destination: null } }, calls), { selection: { kind: 'orders', refs: ['x'] }, maxOrders: 10 })
  assert.equal(report.skippedNotEu, 2)
  assert.deepEqual(calls.build, ['2', '3'])
  assert.deepEqual(calls.xero, ['INV-2', 'INV-3'])
})

test('the maximum is hard: the run asks for one more than the cap, never more than the ceiling, and Xero is asked once per order', async () => {
  const calls = { xero: [] as string[], build: [] as string[], load: [] as string[], list: [] as number[] }
  await runEuVatShadow(ports({ '1': {}, '2': {} }, calls), { selection: { kind: 'orders', refs: ['x'] }, maxOrders: 1_000_000 })
  assert.deepEqual(calls.list, [SHADOW_HARD_MAX_ORDERS + 1])
  assert.deepEqual(calls.xero, ['INV-1', 'INV-2'])
})

test('no personal data reaches the text or the JSON: only the order number and the compared figures', async () => {
  const report = await runEuVatShadow(ports({
    '1001': {}, '1002': { xero: { kind: 'found', invoice: xeroFor('20.25', 126.75) } }, '1003': { ims: { kind: 'refused', reason: 'a refusal IMS wrote' } },
  }), { selection: { kind: 'orders', refs: ['x'] }, maxOrders: 10 })
  const text = renderEuVatShadowText(report)
  const json = JSON.stringify(euVatShadowJson(report))
  for (const leaked of PII) { assert.equal(text.includes(leaked), false, leaked); assert.equal(json.includes(leaked), false, leaked) }
  assert.match(text, /Order 1002: DIFFERS/)
  assert.match(text, /821 NONE 20\.24/)
  assert.match(text, /Summary \(3 compared\)/)
  assert.match(text, /IMS refusals:\n {2}1003: a refusal IMS wrote/)
})

test('arguments: a selection is required, the maximum is bounded, a credential-shaped value is refused unseen', () => {
  const ok = parseEuVatShadowArgs(['--live-read', '--orders', '1001,1002', '--max', '5'])
  assert.ok(!('code' in ok))
  if (!('code' in ok)) { assert.deepEqual(ok.selection, { kind: 'orders', refs: ['1001', '1002'] }); assert.equal(ok.maxOrders, 5); assert.equal(ok.liveRead, true) }
  const range = parseEuVatShadowArgs(['--live-read', '--from', '2026-11-01', '--to', '2026-11-03'])
  assert.ok(!('code' in range) && range.selection?.kind === 'range')
  const bad = (argv: string[]) => { const r = parseEuVatShadowArgs(argv); return 'code' in r ? r.code : 'ok' }
  assert.equal(bad(['--live-read']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--orders', '1', '--from', '2026-11-01', '--to', '2026-11-02']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--from', '2026-11-03', '--to', '2026-11-01']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--from', '2026-11-01']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--orders', '1', '--max', String(SHADOW_HARD_MAX_ORDERS + 1)]), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--orders', '1', '--max', '0']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--orders', '1,2,3', '--max', '2']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--orders', 'https://u:p@host/x']), 'CREDENTIAL_ARGUMENT')
  assert.equal(bad(['--live-read', '--orders', '1', '--token=abc']), 'CREDENTIAL_ARGUMENT')
  assert.equal(bad(['--live-read', '--orders', '1', '--apply']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--live-read', '--live-read', '--orders', '1']), 'BAD_ARGUMENTS')
  assert.equal(bad(['--help']), 'ok')
})

test('the command refuses without --live-read and never reaches a port; with it, it says it performs GETs only', async () => {
  let ran = 0
  const out: string[] = []
  const err: string[] = []
  const deps = { run: async () => { ran += 1; return { maxOrders: 1, truncated: false, unresolved: [], skippedNotEu: 0, results: [], counts: { match: 0, differs: 0, review: 0, no_xero_doc: 0, ims_refused: 0, not_comparable: 0 } } }, disconnect: async () => {} }
  const base = { env: { DATABASE_URL: 'x' }, uid: 0, checkoutOwnerUid: 0, deps, stdout: (t: string) => { out.push(t) }, stderr: (t: string) => { err.push(t) } }
  assert.equal(await runEuVatShadowCli({ ...base, argv: ['--orders', '1'] }), 3)
  assert.equal(ran, 0)
  assert.match(err.join('\n'), /LIVE_READ_REQUIRED/)
  assert.equal(await runEuVatShadowCli({ ...base, argv: ['--live-read', '--orders', '1'] }), 0)
  assert.equal(ran, 1)
  assert.match(err.join('\n'), /GET requests only/)
  assert.equal(await runEuVatShadowCli({ ...base, argv: ['--help'] }), 0)
  assert.match(out.join('\n'), /--live-read is REQUIRED/)
  assert.match(renderEuVatShadowUsage(), /never enqueues, writes, posts, stamps/)
  assert.equal(await runEuVatShadowCli({ ...base, uid: 1234, checkoutOwnerUid: 1, argv: ['--live-read', '--orders', '1'] }), 3)
})

test('a vendor error becomes a closed code: never its text', () => {
  assert.equal(closedCodeOf('WC API error: 401 {"auth":"abc123"} ?auth=secret', 'x'), 'http_401')
  assert.equal(closedCodeOf('something went wrong with token=zzz', 'unreadable'), 'unreadable')
  assert.equal(closedCodeOf(undefined, 'unreadable'), 'unreadable')
})

/**
 * THE SHADOW PATH CALLS ONLY READS. The sources of every function it runs are scanned for a write: a queue, an outbox, a stamp, a setting, a log entry, a POST/PUT, a create/update/upsert/delete.
 */
const FORBIDDEN = [
  /\bxeroPost\b/, /\bxeroPut\b/, /\bwcPost\b/, /\bwcPut\b/, /\bpushSalesInvoice\b/, /\bupdateSalesInvoice\b/, /\bqueueAccounting\w*/, /\bstampEuVatRegime\b/, /\btreatImportedSalesInvoice\b/,
  /\blogActivity\w*/, /\bsetSetting\w*/, /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/, /\$executeRaw/, /\$transaction/, /\brecordWcTaxBinding\b/,
]
function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `${signature} not found`)
  const next = source.slice(start + signature.length).search(/\n(?:export )?(?:async )?function |\n\/\*\*\n/)
  return source.slice(start, next === -1 ? undefined : start + signature.length + next)
}

test('the shadow files and the functions they reach contain no write', () => {
  const whole = ['lib/tax/eu-vat-shadow-live.ts', 'lib/tax/eu-vat-shadow-run.ts', 'lib/tax/eu-vat-shadow-cli.ts', 'lib/domain/accounting/eu-vat-shadow-compare.ts', 'scripts/eu-vat-shadow-report.ts']
  for (const file of whole) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(source), false, `${file} matches ${pattern}`)
  }
  const importer = readFileSync(new URL('../../lib/connectors/woocommerce/sync/order-import.ts', import.meta.url), 'utf8')
  for (const signature of ['export async function buildShadowWcSalesInvoice(', 'async function readFreshWcInvoiceInputs(', 'async function buildFreshWcSalesInvoice(']) {
    const body = sliceFunction(importer, signature).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const pattern of FORBIDDEN) assert.equal(pattern.test(body), false, `${signature} matches ${pattern}`)
  }
  const treatment = readFileSync(new URL('../../lib/connectors/woocommerce/sync/eu-vat-invoice-treatment.ts', import.meta.url), 'utf8')
  const preview = sliceFunction(treatment, 'export async function previewTreatedSalesInvoice(').replace(/Parameters<typeof treatImportedSalesInvoice>/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const pattern of FORBIDDEN) assert.equal(pattern.test(preview), false, `previewTreatedSalesInvoice matches ${pattern}`)
})
