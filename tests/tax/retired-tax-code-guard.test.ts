import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { bindingKeyFor, isTaxCodeKey, taxCodeOccurrences, taxCodesInPayload, taxRateBindings } from '@/lib/tax/tax-code-fields'
import { CLEARED_RATES_SETTING, RETIRED_CODES_SETTING, lockTaxCodeWrites, parseRetiredCodes, retiredTaxCodesInPayload as findings } from '@/lib/tax/retired-tax-code-guard'

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
function client(opts: { retired?: Record<string, unknown>; cleared?: Record<string, unknown>; rates?: Row[]; locks?: string[] }) {
  return {
    $executeRaw: async () => { opts.locks?.push('lock'); return 0 },
    setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === RETIRED_CODES_SETTING && opts.retired ? { value: JSON.stringify(opts.retired) } : where.key === CLEARED_RATES_SETTING && opts.cleared ? { value: JSON.stringify(opts.cleared) } : null) },
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

// [mutation: the cleared-rate check removed -> a line on a cleared rate is admitted]
test('a line bound to a rate a re-key CLEARED (no tax code) is refused whatever code it carries: the connectors would send NONE or another rate\'s code', async () => {
  const c = client({ cleared: { 'cleared-1': { at: '2026-10-25T12:00:00.000Z' } }, rates: RATES })
  assert.deepEqual(await reasons(c, { lines: [{ description: 'x', taxRateId: 'cleared-1' }] }), ['(no tax code):missing_tax_code'], 'no code at all')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX008', taxRateId: 'cleared-1' }] }), ['(no tax code):missing_tax_code'], 'the order default\'s code is no substitute')
  assert.deepEqual(await reasons(c, { lines: [], shippingTaxRateId: 'cleared-1' }), ['(no tax code):missing_tax_code'], 'any field')
  assert.deepEqual(await reasons(c, { lines: [{ taxType: 'TAX008', taxRateId: 'cy-new' }] }), [], 'an ordinary rate is untouched')
  assert.deepEqual(taxRateBindings({ lines: [{ taxRateId: 'a' }, { taxRateId: 'a' }], shippingTaxRateId: 'b', discountTaxRateId: '', other: 'c' }).sort(), ['a', 'b'])
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
  ['app/actions/sales.ts', /taxRateId: l\.taxRateId \?\? undefined/, 'sales invoice / update: line rate'],
  ['app/actions/sales.ts', /shippingTaxRateId: orderDefaultRate\?\.id/, 'sales invoice / update: shipping rate'],
  ['app/actions/sales.ts', /discountTaxRateId: orderDefaultRate\?\.id/, 'sales invoice / update: discount rate'],
  ['app/actions/sales.ts', /if \(own\?\.taxRateId && \(code === undefined/, 'sales credit note / refund lines'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /taxRateId: rateNow\?\.id/, 'WooCommerce import: line rate from the persisted rates'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /shippingTaxRateId: \(shippingRateNow \?\? defaultRateNow\)\?\.id/, 'WooCommerce import: shipping rate'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /discountTaxRateId: defaultRateNow\?\.id/, 'WooCommerce import: discount rate'],
  ['lib/connectors/woocommerce/sync/order-import.ts', /currentTaxRates\(db, \[\.\.\.lineData\.map/, 'WooCommerce import: codes read from the rate rows now'],
  ['lib/domain/purchasing/purchase-invoice-edit.ts', /\.\.\.optionalRateId\(poLine\.taxRate\?\.id \?\? params\.fallbackTaxRateId\)/, 'purchase bill / update: PO line codes'],
  ['lib/domain/purchasing/purchase-invoice-edit.ts', /\.\.\.optionalRateId\(costLine\.vatable \? params\.fallbackTaxRateId/, 'purchase bill / update: cost-line (freight) codes'],
  ['lib/domain/purchasing/supplier-credit-note.ts', /taxRateId: params\.taxRateId/, 'supplier credit note'],
  ['app/actions/purchase-orders.ts', /taxRateId: baseRate\?\.id,/, 'supplier credit note: the rate the type was read from'],
]
// [mutation: any one binding removed from its producer -> that census row fails]
test('CENSUS: every producer of a payload with tax codes binds each code to the rate it was read from', () => {
  for (const [file, pattern, what] of PRODUCERS) assert.match(readFileSync(file, 'utf8'), pattern, `${what} (${file}) must bind its tax codes (lib/tax/retired-tax-code-guard.ts)`)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A CLEARED RATE'S MARKER IS PERMANENT. A binding to it is admitted ONLY on the rate's current valid live code, sent exactly; the guard never writes the setting.
// The double answers the Xero store too (the connected organisation and its ACTIVE list).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
type World = { cleared?: Record<string, unknown>; retired?: Record<string, unknown>; rates: Row[]; live?: Array<{ taxType: string; status?: string; tenantId?: string }>; tenant?: string | null; rc?: { sales?: string; purchase?: string } }
function world(w: World) {
  const log: string[] = []
  const c = {
    $executeRaw: async () => { log.push('lock'); return 0 },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === CLEARED_RATES_SETTING) { log.push('read-cleared'); return w.cleared ? { value: JSON.stringify(w.cleared) } : null }
        if (where.key === 'accounting_reverse_charge_sales_tax_type') return w.rc?.sales ? { value: w.rc.sales } : null
        if (where.key === 'accounting_reverse_charge_purchase_tax_type') return w.rc?.purchase ? { value: w.rc.purchase } : null
        return where.key === RETIRED_CODES_SETTING && w.retired ? { value: JSON.stringify(w.retired) } : null
      },
      upsert: async () => { throw new Error('the guard must never write the cleared setting') },
      update: async () => { throw new Error('the guard must never write the cleared setting') },
      delete: async () => { throw new Error('the guard must never write the cleared setting') },
    },
    taxRate: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => w.rates.filter((r) => where.id.in.includes(r.id)) },
    accountingToken: { findUnique: async () => (w.tenant === null ? null : { tenantId: w.tenant ?? 'org-1' }) },
    xeroTaxRate: { findMany: async ({ where }: { where: { tenantId: string; status: string; taxType: { in: string[] } } }) => (w.live ?? []).filter((r) => (r.tenantId ?? 'org-1') === where.tenantId && (r.status ?? 'ACTIVE') === where.status && where.taxType.in.includes(r.taxType)).map((r) => ({ taxType: r.taxType })) },
  }
  return { c, log }
}
const MARK = { 'c-1': { at: '2026-10-25T12:00:00.000Z' } }
const rate = (id: string, code: string | null, reverseCharge = false): Row => ({ id, active: true, replacedById: null, accountingTaxType: code, reverseCharge } as Row)
const onC1 = { lines: [{ description: 'x', taxType: 'TAX031', taxRateId: 'c-1' }] }
const NOT_CURRENT = ['(tax code not current):tax_code_not_current']
const MISSING = ['(no tax code):missing_tax_code']

// [mutation: the payload's tax type is not compared with the rate's current code -> the stale / missing / default arms fail; mutation: the comparison is against the order default's code -> the admitted arm fails]
test('a marked rate that now has a valid live code admits a binding ONLY when the tax type sent IS that code; a missing, stale or default type is refused so the producer rebuilds', async () => {
  const w = () => world({ cleared: MARK, rates: [rate('c-1', 'TAX031')], live: [{ taxType: 'TAX031' }, { taxType: 'TAX008' }] })
  assert.deepEqual(await reasons(w().c, onC1), [], 'rebuilt after the remap: the rate\'s current code')
  assert.deepEqual(await reasons(w().c, { lines: [{ description: 'x', taxType: 'TAX008', taxRateId: 'c-1' }] }), NOT_CURRENT, 'built BEFORE the remap from the order default\'s code (a live code, but not this rate\'s)')
  assert.deepEqual(await reasons(w().c, { lines: [{ description: 'x', taxRateId: 'c-1' }] }), NOT_CURRENT, 'built before the remap with no type at all')
  assert.deepEqual(await reasons(w().c, { lines: [{ description: 'x', taxType: 'OUTPUT2', taxRateId: 'c-1' }] }), NOT_CURRENT, 'a built-in that is not the rate\'s code')
  assert.deepEqual(await reasons(w().c, { lines: [{ taxType: 'TAX031', taxRateId: 'c-1' }, { taxType: 'TAX008', taxRateId: 'c-1' }] }), NOT_CURRENT, 'one stale line among right ones')
  assert.deepEqual(await reasons(w().c, { lines: [], shippingTaxType: 'TAX031', shippingTaxRateId: 'c-1', discountTaxType: 'TAX008', discountTaxRateId: 'c-1' }), NOT_CURRENT, 'shipping right, discount stale')
  assert.deepEqual(await reasons(w().c, { lines: [], shippingTaxType: 'TAX031', shippingTaxRateId: 'c-1', discountTaxType: 'TAX031', discountTaxRateId: 'c-1', taxType: 'TAX031', taxRateId: 'c-1' }), [], 'every field on the current code')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'OUTPUT2')] }).c, { lines: [{ taxType: 'OUTPUT2', taxRateId: 'c-1' }] }), [], 'a Xero built-in is valid without the stored list')
})

test('a reverse-charge rate may carry the configured reverse-charge type the senders swap its code to, and nothing else', async () => {
  const w = () => world({ cleared: MARK, rates: [rate('c-1', 'TAX031', true)], live: [{ taxType: 'TAX031' }], rc: { sales: 'REVERSECHARGES', purchase: 'RCPURCH' } })
  assert.deepEqual(await reasons(w().c, { lines: [{ taxType: 'REVERSECHARGES', taxRateId: 'c-1' }] }), [])
  assert.deepEqual(await reasons(w().c, { lines: [{ taxType: 'TAX031', taxRateId: 'c-1' }] }), [])
  assert.deepEqual(await reasons(w().c, { lines: [{ taxType: 'TAX099', taxRateId: 'c-1' }] }), NOT_CURRENT)
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'TAX031', false)], live: [{ taxType: 'TAX031' }], rc: { sales: 'REVERSECHARGES' } }).c, { lines: [{ taxType: 'REVERSECHARGES', taxRateId: 'c-1' }] }), NOT_CURRENT, 'not a reverse-charge rate: the swap does not apply')
  // [mutation: the swap allowed for a rate that is not reverse-charge, in a payload that also binds a reverse-charge rate (the type set is then loaded)]
  const mixed = world({ cleared: { ...MARK, 'c-2': { at: 'x' } }, rates: [rate('c-1', 'TAX031', false), rate('c-2', 'TAX032', true)], live: [{ taxType: 'TAX031' }, { taxType: 'TAX032' }], rc: { sales: 'REVERSECHARGES' } })
  assert.deepEqual(await reasons(mixed.c, { lines: [{ taxType: 'REVERSECHARGES', taxRateId: 'c-2' }, { taxType: 'REVERSECHARGES', taxRateId: 'c-1' }] }), NOT_CURRENT, 'the swap is for the reverse-charge rate only')
})

test('a cleared rate still WITHOUT a valid live code is refused: no code, a blank code, an unknown rate, a code the live list does not carry, a malformed code', async () => {
  const live = [{ taxType: 'TAX031' }]
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', null)], live }).c, onC1), MISSING, 'CLEAR with no remap')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', '')], live }).c, onC1), MISSING, 'blank')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [], live }).c, onC1), MISSING, 'unknown rate')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'TAX404')], live }).c, { lines: [{ taxType: 'TAX404', taxRateId: 'c-1' }] }), MISSING, 'a code the stored list does not carry')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'bad code!')], live }).c, { lines: [{ taxType: 'bad code!', taxRateId: 'c-1' }] }), MISSING, 'malformed')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'TAX031')], live: [{ taxType: 'TAX031', status: 'ARCHIVED' }] }).c, onC1), MISSING, 'archived in Xero')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'TAX031')], live: [{ taxType: 'TAX031', tenantId: 'org-2' }] }).c, onC1), MISSING, 'live in another organisation')
  assert.deepEqual(await reasons(world({ cleared: MARK, rates: [rate('c-1', 'TAX031')], live, tenant: null }).c, onC1), MISSING, 'no organisation connected: a custom code cannot be confirmed')
})

// [mutation: a retired / unlisted code is accepted as valid -> the retired arm fails]
test('a remap to a RETIRED code that the live list no longer carries is still refused; a retired code that IS live (a swap) is valid', async () => {
  const retiredSet = { TAX005: { rateId: 'cy-old', newCode: 'TAX008', at: '2026-10-25T12:00:00.000Z' } }
  const stale = world({ cleared: MARK, retired: retiredSet, rates: [rate('c-1', 'TAX005')], live: [{ taxType: 'TAX008' }] })
  assert.deepEqual(await reasons(stale.c, { lines: [{ taxType: 'TAX005', taxRateId: 'c-1' }] }), MISSING, 'TAX005 is retired and not live: the rate carries it but it is not a valid live code')
  const swap = world({ cleared: MARK, retired: retiredSet, rates: [rate('c-1', 'TAX005')], live: [{ taxType: 'TAX005' }] })
  assert.deepEqual(await reasons(swap.c, { lines: [{ taxType: 'TAX005', taxRateId: 'c-1' }] }), [], 'live under its new meaning, bound to the rate that carries it')
})

// [mutation: the marker is deleted when a valid code is assigned (the guard, or any writer) -> the cleared-again arm in the DB tier fails; here: the guard never writes]
test('the guard never writes the cleared setting, and an ordinary rate or an unmarked binding is untouched', async () => {
  const w = world({ cleared: MARK, rates: [rate('c-1', null), rate('ok', 'TAX031')], live: [{ taxType: 'TAX031' }] })
  assert.deepEqual(await reasons(w.c, { lines: [{ taxType: 'TAX031', taxRateId: 'ok' }] }), [])
  await reasons(w.c, onC1) // would throw if it wrote
})

// [mutation: the clearing edit takes no lock -> the DB tier's racing arm fails]
test('lockTaxCodeWrites takes the selection lock, and is a no-op for a client that cannot be locked', async () => {
  const w = world({ rates: [] })
  await lockTaxCodeWrites(w.c)
  assert.deepEqual(w.log, ['lock'])
  await lockTaxCodeWrites({ taxRate: {} })
})
