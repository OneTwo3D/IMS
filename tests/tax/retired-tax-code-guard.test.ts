import assert from 'node:assert/strict'
import test from 'node:test'

import { isTaxCodeKey, taxCodesInPayload } from '@/lib/tax/tax-code-fields'
import { REKEY_QUARANTINE_MS, RETIRED_CODES_SETTING, parseRetiredCodes, retiredTaxCodesInPayload as findings } from '@/lib/tax/retired-tax-code-guard'

/**
 * THE TAX-CODE FIELDS OF AN ACCOUNTING PAYLOAD (lib/tax/tax-code-fields.ts) AND THE ENQUEUE GUARD AGAINST A RE-KEYED-AWAY CODE (lib/tax/retired-tax-code-guard.ts), over doubles.
 * The committed behaviour (the real insert, the shared lock, the apply seeing a queued row) is in tests/concurrency/tax-rekey.concurrent.test.ts. Each guard has a
 * `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

// [mutation: only `taxType` read (shippingTaxType / discountTaxType ignored) -> the arm fails]
test('every tax-code field is found by name: line, header, shipping, discount and nested; reportTaxType and non-strings are not codes', () => {
  const payload = {
    lines: [{ taxType: 'TAX005', description: 'x' }, { taxType: 'TAX005' }, { taxType: '' }, { taxType: 7 }],
    shippingTaxType: 'TAX006', discountTaxType: 'TAX007', taxType: 'TAX008',
    nested: { deeper: [{ creditNoteTaxType: 'TAX009' }] }, reportTaxType: 'OUTPUT', note: 'TAX099',
  }
  assert.deepEqual(taxCodesInPayload(payload), ['TAX005', 'TAX006', 'TAX007', 'TAX008', 'TAX009'])
  assert.deepEqual(taxCodesInPayload({ shippingTaxType: 'TAX006' }), ['TAX006'], 'a code ONLY in shippingTaxType is found')
  assert.deepEqual(taxCodesInPayload({ discountTaxType: 'TAX007' }), ['TAX007'])
  assert.deepEqual([taxCodesInPayload(null), taxCodesInPayload('TAX005'), taxCodesInPayload(undefined)], [[], [], []])
  assert.deepEqual(['taxType', 'shippingTaxType', 'accountingTaxType'].map(isTaxCodeKey), [true, true, true])
  assert.deepEqual(['reportTaxType', 'taxTypes', 'description'].map(isTaxCodeKey), [false, false, false])
})

type Rates = Array<{ id: string; accountingTaxType: string | null; active: boolean }>
const AT = new Date('2026-10-25T12:00:00Z')
const codesOf = async (c: unknown, input: { type: string; payload: unknown; now?: Date }) => (await findings(c, input)).map((f) => f.code)
const retiredTaxCodesInPayload = codesOf
function client(opts: { retired?: Record<string, unknown>; rates?: Rates; locks?: string[] }) {
  return {
    $executeRaw: async () => { opts.locks?.push('lock'); return 0 },
    setting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key === RETIRED_CODES_SETTING && opts.retired ? { value: JSON.stringify(opts.retired) } : null) },
    taxRate: { findMany: async ({ where }: { where: { accountingTaxType: { in: string[] } } }) => (opts.rates ?? []).filter((r) => r.active && r.accountingTaxType !== null && where.accountingTaxType.in.includes(r.accountingTaxType)) },
  }
}
const retired = { TAX005: { rateId: 'old', newCode: 'TAX008', at: AT.toISOString() } }
const sales = (payload: unknown) => ({ type: 'SALES_INVOICE', payload })

// [mutation: the retired-set check removed (any inactive-only code refused) -> the operator-deactivated arm fails; mutation: the active-carrier check removed -> the swap arm fails]
test('the guard refuses a retired code that no active rate carries, in any tax-code field, and nothing else', async () => {
  const c = client({ retired, rates: [] })
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'TAX005' }] })), ['TAX005'])
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [], shippingTaxType: 'TAX005' })), ['TAX005'], 'old code only in shippingTaxType')
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [], discountTaxType: 'TAX005' })), ['TAX005'], 'old code only in discountTaxType')
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'TAX008' }] })), [], 'control: the new code passes')
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'TAX031' }] })), [], 'a code a re-key did not retire passes even if only an inactive rate carries it (operator-deactivated history)')
  assert.deepEqual(await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'OUTPUT2' }, { taxType: 'NONE' }] })), [], 'built-ins pass')
  assert.deepEqual(await retiredTaxCodesInPayload(client({ retired, rates: [{ id: 'old', accountingTaxType: 'TAX005', active: true }] }), { ...sales({ lines: [{ taxType: 'TAX005' }] }), now: new Date(AT.getTime() + 1_000) }), [], 'the very rate it was retired from is active again: same meaning, passes')
  assert.deepEqual(await retiredTaxCodesInPayload(c, { type: 'TAX_RATE_SYNC', payload: { components: [{ accountingTaxType: 'TAX005' }] } }), [], 'a rate definition is not a use of the code')
  assert.deepEqual(await retiredTaxCodesInPayload(client({ rates: [] }), sales({ lines: [{ taxType: 'TAX005' }] })), [], 'nothing retired -> nothing refused')
})

// [mutation: the advisory lock removed from the guard -> the arm fails (and the committed interleaving arm in the concurrency tier)]
test('the guard takes the shared advisory lock when, and only when, the payload carries a custom code; a client that cannot be guarded is not', async () => {
  const locks: string[] = []
  const c = client({ retired, locks })
  await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'TAX005' }] }))
  assert.equal(locks.length, 1)
  await retiredTaxCodesInPayload(c, sales({ lines: [{ taxType: 'OUTPUT2' }] }))
  await retiredTaxCodesInPayload(c, sales({ lines: [] }))
  assert.equal(locks.length, 1, 'no custom code, no lock')
  assert.deepEqual(await retiredTaxCodesInPayload({ accountingSyncLog: {} }, sales({ lines: [{ taxType: 'TAX005' }] })), [])
})

test('the retired-codes setting is parsed defensively', () => {
  assert.deepEqual(parseRetiredCodes(null), {})
  assert.deepEqual(parseRetiredCodes('not json'), {})
  assert.deepEqual(parseRetiredCodes('[1]'), {})
  assert.deepEqual(Object.keys(parseRetiredCodes(JSON.stringify(retired))), ['TAX005'])
})

// [mutation: the quarantine branch removed -> the swap arm passes the stale CY payload; mutation: the window never ends (or is not checked against retired.at) -> the after-the-window arm fails]
test('A CODE SWAP: CY VAT retires TAX005 while BG VAT gets it; a CY payload built before and enqueued after is refused in the quarantine window, a payload after the window is accepted', async () => {
  const c = client({ retired, rates: [{ id: 'bg-new', accountingTaxType: 'TAX005', active: true }] })
  const payload = sales({ lines: [{ taxType: 'TAX005' }] })
  const at = (ms: number) => ({ ...payload, now: new Date(AT.getTime() + ms) })
  assert.deepEqual(await findings(c, at(1_000)), [{ code: 'TAX005', reason: 'retired_tax_code_in_quarantine' }], 'seconds after the commit: the CY payload carrying the BG code is refused')
  assert.deepEqual(await findings(c, at(REKEY_QUARANTINE_MS - 1)), [{ code: 'TAX005', reason: 'retired_tax_code_in_quarantine' }])
  assert.deepEqual(await findings(c, at(REKEY_QUARANTINE_MS)), [], 'after the window a payload carrying TAX005 was built from current rows (BG VAT)')
  assert.deepEqual(await findings(c, { ...sales({ lines: [], shippingTaxType: 'TAX005' }), now: new Date(AT.getTime() + 1_000) }), [{ code: 'TAX005', reason: 'retired_tax_code_in_quarantine' }], 'in any tax-code field')
  assert.deepEqual(await findings(client({ retired, rates: [] }), at(1_000)), [{ code: 'TAX005', reason: 'retired_tax_code' }], 'no active carrier: refused whatever the age')
  assert.deepEqual(await findings(client({ retired, rates: [] }), at(REKEY_QUARANTINE_MS * 10)), [{ code: 'TAX005', reason: 'retired_tax_code' }])
  assert.deepEqual(await findings(client({ retired: { TAX005: { rateId: 'old', newCode: 'X', at: 'garbage' } }, rates: [{ id: 'bg-new', accountingTaxType: 'TAX005', active: true }] }), at(REKEY_QUARANTINE_MS * 10)), [{ code: 'TAX005', reason: 'retired_tax_code_in_quarantine' }], 'an unreadable timestamp fails closed')
})
