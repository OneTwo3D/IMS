import assert from 'node:assert/strict'
import test from 'node:test'

import { planWcOrderCoupons, wcUpdateNeedsStoreCreditReview } from '@/lib/connectors/woocommerce/sync/coupon-classification'
import { resolveWcOrderLevelDiscount } from '@/lib/connectors/woocommerce/sync/field-mapping'
import type { WcCouponLine, WcMeta } from '@/lib/connectors/woocommerce/sync/types'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * THE INVARIANT, proved by generation rather than by listing the cases found so far:
 *
 *   ANY evidence of store credit that is not a clean, fully parsed, fully reconciled credit is REFUSED on import
 *   and puts the order in REVIEW on update. An order is NEVER created with a store credit of 0 and no hold while
 *   credit evidence is present in a form that is not clean.
 *
 * Two baselines (a clean credit order, and an order with no credit at all) have ONE evidence field at a time set to
 * each of ~dozens of shapes. Each shape carries an explicit ORACLE (`clean`) written from the specification of the
 * clean shapes, never derived from the code under test. The outcome must be: clean => imported with exactly the
 * baseline's credit and no hold; anything else => refused on import and held on update.
 */

let id = 1
const meta = (key: string, value: unknown): WcMeta => ({ id: id++, key, value } as WcMeta)
const INFO_OK = '[1,"sc","smart_coupon","50"]'
const DATA_OK = { id: 1, discount_type: 'smart_coupon' }

type Payload = { coupon_lines: WcCouponLine[]; meta_data: WcMeta[] }
type Baseline = { name: string; credit: number; build: (mutate?: (p: Payload) => void) => Payload }

function creditLine(over: Partial<WcCouponLine> & { discount?: unknown; discount_tax?: unknown } = {}, metaData?: WcMeta[]): WcCouponLine {
  return { id: id++, code: 'sc', discount: '10.00', discount_tax: '2.00', meta_data: metaData ?? [meta('coupon_info', INFO_OK)], ...over } as WcCouponLine
}

const CREDIT: Baseline = {
  name: 'clean credit order',
  credit: 12,
  build: (mutate) => {
    const p: Payload = { coupon_lines: [creditLine()], meta_data: [meta('smart_coupons_contribution', { sc: 12 })] }
    mutate?.(p)
    return p
  },
}
const NONE: Baseline = {
  name: 'order with no credit',
  credit: 0,
  build: (mutate) => {
    const p: Payload = { coupon_lines: [{ id: id++, code: 'p', discount: '5.00', discount_tax: '1.00', meta_data: [meta('coupon_info', '[2,"p","percent","10"]')] } as WcCouponLine], meta_data: [] }
    mutate?.(p)
    return p
  },
}

type Variant = { field: string; label: string; apply: (p: Payload) => void; cleanFor: (b: Baseline) => boolean }
const variants: Variant[] = []
const add = (field: string, label: string, apply: Variant['apply'], cleanFor: (b: Baseline) => boolean) => variants.push({ field, label, apply, cleanFor })

// ---- F1: the order's smart_coupons_contribution value, every shape, with and without a matching coupon line ----
const setContribution = (value: unknown) => (p: Payload) => {
  p.meta_data = p.meta_data.filter((m) => m.key !== 'smart_coupons_contribution')
  if (value !== undefined) p.meta_data.push(meta('smart_coupons_contribution', value))
}
const CONTRIBUTION_SHAPES: Array<[string, unknown, (b: Baseline) => boolean]> = [
  ['absent', undefined, () => true],
  ['null', null, () => false],
  ["''", '', () => false],
  ['0', 0, () => false],
  ["'0'", '0', () => false],
  ["'abc'", 'abc', () => false],
  ['[]', [], () => false],
  ['{}', {}, () => false],
  ['[1]', [1], () => false],
  ['{code:null}', { code: null }, () => false],
  ['malformed JSON string', '{"sc": 12', () => false],
  ['-5', -5, () => false],
  ['NaN', Number.NaN, () => false],
  ['1e30', 1e30, () => false],
  ['{sc:"abc"}', { sc: 'abc' }, () => false],
  ['{sc:-1}', { sc: -1 }, () => false],
  ['{sc:null}', { sc: null }, () => false],
  ['{sc:[12]}', { sc: [12] }, () => false],
  ['nested {sc:{amount:12}}', { sc: { amount: 12 } }, () => false],
  ['JSON string of a clean map', '{"sc":"12.00"}', (b) => b === CREDIT],
  ['clean map, string amount', { sc: '12' }, (b) => b === CREDIT],
  ['clean map, other case + spaces', { ' SC ': 12 }, (b) => b === CREDIT],
  ['orphan code in a clean map', { sc: 12, ghost: 3 }, () => false],
  ['zero amount orphan', { ghost: 0 }, () => false],
]
for (const [label, value, clean] of CONTRIBUTION_SHAPES) add('contribution', label, setContribution(value), clean)

// ---- F2: the credit line's amounts (only meaningful when the baseline has the credit line) ----
const setLine = (key: 'discount' | 'discount_tax', value: unknown) => (p: Payload) => {
  const line = p.coupon_lines.find((l) => l.code === 'sc')
  if (!line) return
  if (value === undefined) delete (line as Record<string, unknown>)[key]
  else (line as Record<string, unknown>)[key] = value
}
// `valid` stands for the baseline's own figure (discount 10.00 / discount_tax 2.00), substituted per field below.
const AMOUNT_SHAPES: Array<[string, unknown, boolean]> = [
  ['valid', '@same', true], ['valid number', '@number', true], ['undefined', undefined, false], ['null', null, false], ["''", '', false],
  ["'abc'", 'abc', false], ["'-1'", '-1', false], ['NaN', Number.NaN, false], ['Infinity', Number.POSITIVE_INFINITY, false],
  ['[]', [], false], ['{}', {}, false],
]
const BASE_AMOUNT = { discount: '10.00', discount_tax: '2.00' } as const
for (const [label, value, ok] of AMOUNT_SHAPES) {
  for (const key of ['discount', 'discount_tax'] as const) {
    const concrete = value === '@same' ? BASE_AMOUNT[key] : value === '@number' ? Number(BASE_AMOUNT[key]) : value
    add(key, label, setLine(key, concrete), (b) => b === NONE || ok)
  }
}

// ---- F3 / F4: the item type records ----
const setInfo = (value: unknown) => (p: Payload) => {
  const line = p.coupon_lines.find((l) => l.code === 'sc')
  if (!line) return
  line.meta_data = (line.meta_data ?? []).filter((m) => m.key !== 'coupon_info')
  if (value !== undefined) line.meta_data.push(meta('coupon_info', value))
}
const setData = (value: unknown) => (p: Payload) => {
  const line = p.coupon_lines.find((l) => l.code === 'sc')
  if (!line) return
  line.meta_data = (line.meta_data ?? []).filter((m) => m.key !== 'coupon_data')
  if (value !== undefined) line.meta_data.push(meta('coupon_data', value))
}
// Clean credit needs EVERY readable source to agree on smart_coupon. With the contribution listing the code, an ABSENT coupon_info is clean.
const INFO_SHAPES: Array<[string, unknown, boolean]> = [
  ['valid smart_coupon', INFO_OK, true], ['absent (contribution lists it)', undefined, true],
  ['null', null, false], ["''", '', false], ["'abc'", 'abc', false], ["'[]'", '[]', false], ["'[1,\"sc\"]'", '[1,"sc"]', false],
  ["'{}'", '{}', false], ['123', 123, false], ["empty type", '[1,"sc","","50"]', false],
  ['says percent', '[1,"sc","percent","50"]', false], ['says fixed_cart', '[1,"sc","fixed_cart","50"]', false], ['says unknown type', '[1,"sc","acme","50"]', false],
]
for (const [label, value, ok] of INFO_SHAPES) add('coupon_info', label, setInfo(value), (b) => b === NONE || ok)
const DATA_SHAPES: Array<[string, unknown, boolean]> = [
  ['absent', undefined, true], ['agrees (smart_coupon)', DATA_OK, true],
  ['null', null, false], ["''", '', false], ["'abc'", 'abc', false], ['[]', [], false], ['{}', {}, false], ['123', 123, false],
  ['discount_type null', { discount_type: null }, false], ['discount_type percent', { discount_type: 'percent' }, false],
]
for (const [label, value, ok] of DATA_SHAPES) add('coupon_data', label, setData(value), (b) => b === NONE || ok)

// ---- F5: wallet / gift-card order meta ----
const setWallet = (key: string, value: unknown) => (p: Payload) => { if (value !== undefined) p.meta_data.push(meta(key, value)) }
const WALLET_SHAPES: Array<[string, unknown, boolean]> = [
  ['absent', undefined, true], ["''", '', true], ['0', 0, true], ["'0'", '0', true], ["'0.00'", '0.00', true],
  ['null', null, false], ["'abc'", 'abc', false], ['[]', [], false], ['{}', {}, false], ['[1]', [1], false], ['-1', -1, false],
  ['NaN', Number.NaN, false], ['5', 5, false], ["'10.00'", '10.00', false], ['1e30', 1e30, false], ['object', { a: 1 }, false],
]
for (const key of ['_used_wallet_amount', '_ywgc_applied_gift_cards_total', '_store_credit_used']) {
  for (const [label, value, ok] of WALLET_SHAPES) add(key, label, setWallet(key, value), () => ok)
}

// ---- F6: credit words on a line that is NOT cleanly typed ----
add('line code', "untyped line named 'storecredit' (allocated)", (p) => { p.coupon_lines.push({ id: id++, code: 'storecredit', discount: '1.00', discount_tax: '0.00', meta_data: [] } as WcCouponLine) }, () => false)
add('line code', "percent-typed line named 'GIFTCARD10' (cleanly typed genuine)", (p) => { p.coupon_lines.push({ id: id++, code: 'giftcard10', discount: '1.00', discount_tax: '0.00', meta_data: [meta('coupon_info', '[3,"giftcard10","percent","10"]')] } as WcCouponLine) }, () => true)

function importOutcome(b: Baseline, payload: Payload): { refused: boolean; credit: number } {
  const lineDiscount = payload.coupon_lines.reduce((s, l) => s + (Number.isFinite(Number(l.discount)) ? Number(l.discount) : 0) * 0, 0)
  const result = planWcOrderCoupons({
    couponLines: payload.coupon_lines,
    orderMeta: payload.meta_data,
    // Woo allocated every genuine coupon into the lines; the credit is NOT in them. The residual is therefore 0 for genuine coupons.
    lineDiscountTotalForeign: toDecimal(payload.coupon_lines.filter((l) => !/sc|storecredit/.test(String(l.code))).reduce((s, l) => s + (Number(l.discount) || 0), 0) + lineDiscount),
    currency: 'GBP',
    resolveResidual: (args) => resolveWcOrderLevelDiscount(args),
  })
  void b
  return { refused: result.refusal !== null, credit: result.storeCreditForeign.toNumber() }
}

test('INVARIANT: no shape of credit evidence yields an order created with credit 0 and no hold unless the evidence is clean', () => {
  const rows: string[] = []
  let refusedCount = 0
  let cleanCount = 0
  let checked = 0
  for (const baseline of [CREDIT, NONE]) {
    for (const v of variants) {
      // Line-field variants only mean something for the baseline that HAS that line.
      if (baseline === NONE && ['discount', 'discount_tax', 'coupon_info', 'coupon_data'].includes(v.field) && v.label !== 'valid') continue
      const payload = baseline.build(v.apply)
      const clean = v.cleanFor(baseline)
      const imp = importOutcome(baseline, payload)
      const storedCredit = baseline.credit
      const needsReview = wcUpdateNeedsStoreCreditReview(payload, { storeCreditForeign: String(storedCredit), storeCreditAssessment: 'ASSESSED' })
      checked++
      rows.push(`${baseline.name} | ${v.field} = ${v.label} | oracle=${clean ? 'CLEAN' : 'EVIDENCE'} | import=${imp.refused ? 'REFUSED' : `created credit ${imp.credit}`} | update=${needsReview ? 'HELD' : 'no hold'}`)
      if (clean) {
        cleanCount++
        assert.equal(imp.refused, false, `clean shape refused: ${rows[rows.length - 1]}`)
        assert.equal(imp.credit, baseline.credit, `clean shape lost its credit: ${rows[rows.length - 1]}`)
        assert.equal(needsReview, false, `clean shape held: ${rows[rows.length - 1]}`)
      } else {
        refusedCount++
        assert.equal(imp.refused, true, `EVIDENCE NOT REFUSED ON IMPORT (created with credit ${imp.credit}): ${rows[rows.length - 1]}`)
        assert.equal(needsReview, true, `EVIDENCE NOT HELD ON UPDATE: ${rows[rows.length - 1]}`)
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION evidence invariant table (${checked} shapes: ${cleanCount} clean, ${refusedCount} evidence):\n  ${rows.join('\n  ')}`)
  assert.ok(checked >= 150, 'precondition: the generator produced a real matrix')
  assert.ok(refusedCount >= 100 && cleanCount >= 20, 'and both outcomes are exercised, so the assertion can fail either way')
})

test('the stored credit never changes the answer for a clean payload, and a stale credit is held', () => {
  const clean = CREDIT.build()
  assert.equal(wcUpdateNeedsStoreCreditReview(clean, { storeCreditForeign: '12.0000', storeCreditAssessment: 'ASSESSED' }), false)
  assert.equal(wcUpdateNeedsStoreCreditReview(clean, { storeCreditForeign: '9.0000', storeCreditAssessment: 'ASSESSED' }), true, 'credit changed in WooCommerce')
  assert.equal(wcUpdateNeedsStoreCreditReview(clean, { storeCreditForeign: '0.0000', storeCreditAssessment: null }), true, 'not assessed')
  assert.equal(wcUpdateNeedsStoreCreditReview(clean, { storeCreditForeign: '12.0000', storeCreditAssessment: 'REVIEW_REQUIRED' }), false, 'already held')
})
