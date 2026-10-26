import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { bindingKeyFor, isTaxCodeKey, taxCodeOccurrences, taxCodesInPayload } from '@/lib/tax/tax-code-fields'
import { RETIRED_CODES_SETTING, parseRetiredCodes, retiredTaxCodesInPayload as findings } from '@/lib/tax/retired-tax-code-guard'

/**
 * THE TAX-CODE FIELDS OF AN ACCOUNTING PAYLOAD AND THE SOURCE BINDING OF EACH (lib/tax/tax-code-fields.ts) AND THE ENQUEUE GUARD (lib/tax/retired-tax-code-guard.ts), over doubles.
 * The committed behaviour (the real insert, the shared lock, the apply seeing a queued row) is in tests/concurrency/tax-rekey.concurrent.test.ts. Each guard has a
 * `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

// [mutation: only `taxType` read (shippingTaxType / discountTaxType ignored) -> the arm fails]
test('every tax-code field is found by name with the rate id bound beside it; reportTaxType and non-strings are not codes', () => {
  const payload = {
    lines: [{ taxType: 'TAX005', taxRateId: 'r1', description: 'x' }, { taxType: 'TAX005' }, { taxType: '' }, { taxType: 7 }],
    shippingTaxType: 'TAX006', shippingTaxRateId: 'r2', discountTaxType: 'TAX007', taxType: 'TAX008', taxRateId: 'r3',
    nested: { deeper: [{ creditNoteTaxType: 'TAX009' }] }, reportTaxType: 'OUTPUT', note: 'TAX099',
  }
  assert.deepEqual(taxCodesInPayload(payload), ['TAX005', 'TAX006', 'TAX007', 'TAX008', 'TAX009'])
  assert.deepEqual(taxCodeOccurrences(payload).map((o) => [o.code, o.taxRateId]), [['TAX005', 'r1'], ['TAX005', null], ['TAX006', 'r2'], ['TAX007', null], ['TAX008', 'r3'], ['TAX009', null]])
  assert.deepEqual(['taxType', 'shippingTaxType', 'discountTaxType', 'creditNoteTaxType'].map(bindingKeyFor), ['taxRateId', 'shippingTaxRateId', 'discountTaxRateId', 'creditNoteTaxRateId'])
  assert.deepEqual([taxCodesInPayload(null), taxCodesInPayload('TAX005'), taxCodesInPayload(undefined)], [[], [], []])
  assert.deepEqual(['taxType', 'shippingTaxType', 'accountingTaxType'].map(isTaxCodeKey), [true, true, true])
  assert.deepEqual(['reportTaxType', 'taxTypes', 'description'].map(isTaxCodeKey), [false, false, false])
})

type Row = { id: string; active: boolean; replacedById: string | null; accountingTaxType: string | null }
function client(opts: { retired?: Record<string, unknown>; rates?: Row[]; locks?: string[] }) {
  return {
    $executeRaw: async () => { opts.locks?.push('lock'); return 0 },
    setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === RETIRED_CODES_SETTING && opts.retired ? { value: JSON.stringify(opts.retired) } : null) },
    taxRate: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => (opts.rates ?? []).filter((r) => where.id.in.includes(r.id)) },
  }
}
const retired = { TAX005: { rateId: 'cy-old', newCode: 'TAX008', at: '2026-10-25T12:00:00.000Z' } }
const RATES: Row[] = [
  { id: 'bg-new', active: true, replacedById: null, accountingTaxType: 'TAX005' },
  { id: 'cy-old', active: false, replacedById: 'cy-new', accountingTaxType: 'TAX005' },
  { id: 'cy-old-reactivated', active: true, replacedById: 'cy-new', accountingTaxType: 'TAX005' },
  { id: 'cy-new', active: true, replacedById: null, accountingTaxType: 'TAX008' },
  { id: 'off', active: false, replacedById: null, accountingTaxType: 'TAX005' },
]
const sales = (payload: unknown) => ({ type: 'SALES_INVOICE', payload })
const reasons = async (c: unknown, p: unknown) => (await findings(c, sales(p))).map((f) => `${f.code}:${f.reason}`)

// [mutation: the binding not checked (any retired code an active rate carries is admitted) -> the stale / unbound / reactivated arms fail; mutation: a time-based admission restored -> the "any time" arm fails]
test('a retired code is admitted ONLY for an occurrence bound to a rate that is active, not replaced and carries that code; elapsed time proves nothing', async () => {
  const c = client({ retired, rates: RATES })
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'bg-new' }] }), [], 'built from the live BG VAT row: admitted')
  // CODEX'S SCENARIO: CY's TAX005 read from the OLD CY row, enqueued long after (no clock is consulted at all).
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'cy-old' }] }), ['TAX005:retired_tax_code'])
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'cy-old-reactivated' }] }), ['TAX005:retired_tax_code'], 'a replaced row someone reactivated')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'off' }] }), ['TAX005:retired_tax_code'], 'an inactive rate')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'cy-new' }] }), ['TAX005:retired_tax_code'], 'a rate that carries another code')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'nowhere' }] }), ['TAX005:retired_tax_code'], 'an unknown rate')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005' }] }), ['TAX005:retired_tax_code_unbound'], 'no binding at all')
  // Every occurrence, in every field, needs its own valid binding.
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'bg-new' }, { taxType: 'TAX005', taxRateId: 'cy-old' }] }), ['TAX005:retired_tax_code'], 'one stale line among valid ones')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX005', taxRateId: 'bg-new' }], shippingTaxType: 'TAX005' }), ['TAX005:retired_tax_code_unbound'])
  assert.deepEqual(await reasons(c, { lines: [], shippingTaxType: 'TAX005', shippingTaxRateId: 'cy-old' }), ['TAX005:retired_tax_code'])
  assert.deepEqual(await reasons(c, { lines: [], discountTaxType: 'TAX005', discountTaxRateId: 'bg-new' }), [])
  assert.deepEqual(await reasons(c, { taxType: 'TAX005', taxRateId: 'bg-new', lines: [] }), [], 'header-level code')
  // Not looked at: codes no re-key retired, built-ins, rate definitions.
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX031' }, { taxType: 'OUTPUT2' }, { taxType: 'NONE' }] }), [])
  assert.deepEqual(await findings(c, { type: 'TAX_RATE_SYNC', payload: { components: [{ accountingTaxType: 'TAX005' }] } }), [])
  assert.deepEqual(await reasons(client({ rates: RATES }), { lines: [{ taxType: 'TAX005', taxRateId: 'cy-old' }] }), [], 'nothing retired -> nothing refused')
})

test('the guard has no clock: elapsed time is not evidence', () => {
  const text = readFileSync('lib/tax/retired-tax-code-guard.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/Date\b|QUARANTINE|Date\.now|\.at\b|getTime/.test(text), false, 'no time-based admission in the guard')
})

// [mutation: the advisory lock removed from the guard -> the arm fails (and the committed interleaving arm in the concurrency tier)]
test('the guard takes the shared advisory lock when, and only when, the payload carries a custom code; a client that cannot be guarded is not', async () => {
  const locks: string[] = []
  const c = client({ retired, rates: RATES, locks })
  await findings(c, sales({ lines: [{ taxType: 'TAX005', taxRateId: 'bg-new' }] }))
  assert.equal(locks.length, 1)
  await findings(c, sales({ lines: [{ taxType: 'OUTPUT2' }] }))
  await findings(c, sales({ lines: [] }))
  assert.equal(locks.length, 1, 'no custom code, no lock')
  assert.deepEqual(await findings({ accountingSyncLog: {} }, sales({ lines: [{ taxType: 'TAX005' }] })), [])
})

test('the retired-codes setting is parsed defensively', () => {
  assert.deepEqual(parseRetiredCodes(null), {})
  assert.deepEqual(parseRetiredCodes('not json'), {})
  assert.deepEqual(parseRetiredCodes('[1]'), {})
  assert.deepEqual(Object.keys(parseRetiredCodes(JSON.stringify(retired))), ['TAX005'])
})

// ---- the census: every producer that builds a payload with tax codes binds them -------------------------------------------
const PRODUCERS: Array<[string, RegExp, string]> = [
  ['app/actions/sales.ts', /taxRateId: l\.taxRateId && taxType === /, 'sales invoice / update: line codes'],
  ['app/actions/sales.ts', /shippingTaxRateId: orderDefaultTaxType \? orderDefaultRate\?\.id/, 'sales invoice / update: shipping code'],
  ['app/actions/sales.ts', /discountTaxRateId: orderDefaultTaxType \? orderDefaultRate\?\.id/, 'sales invoice / update: discount code'],
  ['app/actions/sales.ts', /own\.taxRate\?\.accountingTaxType === code\) return own\.taxRateId/, 'sales credit note / refund lines'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /taxRateId: rateNow && lineTaxType === rateNow\.accountingTaxType/, 'WooCommerce import: line codes from the persisted rates'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /shippingTaxRateId: shippingRateNow/, 'WooCommerce import: shipping code'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /discountTaxRateId: defaultRateNow/, 'WooCommerce import: discount code'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /currentTaxRates\(db, \[\.\.\.lineData\.map/, 'WooCommerce import: codes read from the rate rows now'],
  ['lib/domain/purchasing/purchase-invoice-edit.ts', /taxRateId: poLine\.taxRate\?\.accountingTaxType != null/, 'purchase bill / update: PO line codes'],
  ['lib/domain/purchasing/purchase-invoice-edit.ts', /taxRateId: costLine\.vatable \? params\.fallbackTaxRateId/, 'purchase bill / update: cost-line (freight) codes'],
  ['lib/domain/purchasing/supplier-credit-note.ts', /taxRateId: params\.taxRateId/, 'supplier credit note'],
  ['app/actions/purchase-orders.ts', /taxRateId: baseRate\?\.id && creditNoteTaxType === baseTaxType/, 'supplier credit note: the rate the type was read from'],
]
// [mutation: any one binding removed from its producer -> that census row fails]
test('CENSUS: every producer of a payload with tax codes binds each code to the rate it was read from', () => {
  for (const [file, pattern, what] of PRODUCERS) assert.match(readFileSync(file, 'utf8'), pattern, `${what} (${file}) must bind its tax codes (lib/tax/retired-tax-code-guard.ts)`)
})
