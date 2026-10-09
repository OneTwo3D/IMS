import assert from 'node:assert/strict'
import test from 'node:test'
import { roundQuantity } from '../lib/domain/math/decimal.ts'
import { buildPushPayload } from '../lib/connectors/mintsoft/api/order-push.ts'
import { buildPushInput, payloadTotalMismatchPence } from '../lib/domain/wms/order-push-sweep.ts'
import {
  PUSH_TOTAL_MISMATCH_OPERATOR_NOTE,
  reconcilePushTotals,
  roundingBoundMinorUnits,
  withheldGoodsGross,
  withheldLineCount,
  MAX_ROUNDING_BOUND_MINOR_UNITS,
  PAYLOAD_TOTALS_DECIMALS,
  type PushTotalsVerdict,
} from '../lib/domain/wms/push-total-guard.ts'
import { formatMismatchAmount, MAX_ADVISORY_PENCE } from '../lib/domain/wms/push-total-mismatch-note.ts'
import { unconditionalMoneySentences, unlicensedHistoryClaims } from './helpers/unconditional-instruction.ts'

type Line = { id: string; sku: string; qty: number; totalForeign: number; taxForeign: number; description: string }
type Fixture = {
  name: string
  currency?: string
  lines: Line[]
  shippingForeign?: number
  taxForeign: number
  discountAmount?: number
  pricesIncludeVat?: boolean
  totalForeign: number
  refunded?: Record<string, number>
  expectStatus: PushTotalsVerdict['status']
  expectDriftMinor?: number
  expectCause?: PushTotalsVerdict['cause']
  expectVatGap?: string
}

const L = (id: string, qty: number, totalForeign: number, taxForeign: number): Line => ({ id, sku: `SKU-${id}`, qty, totalForeign, taxForeign, description: id })

const nineLines = Array.from({ length: 9 }, (_, i) => L(`n${i}`, 1, 1.67, 0.33))

const tenLines = Array.from({ length: 10 }, (_, i) => L(`t${i}`, 1, 1.67, 0.33))

const FIXTURES: Fixture[] = [
  { name: 'single line, 20% VAT, exact', lines: [L('a', 1, 10, 2)], taxForeign: 2, totalForeign: 12, expectStatus: 'RECONCILED', expectDriftMinor: 0, expectVatGap: '0.00' },
  { name: 'multi-line with shipping that carries VAT (VAT not itemised on shipping)', lines: [L('a', 2, 20, 4), L('b', 1, 30, 6), L('c', 3, 10, 2)], shippingForeign: 5, taxForeign: 13, totalForeign: 78, expectStatus: 'RECONCILED', expectDriftMinor: 0, expectVatGap: '1.00' },
  { name: 'order-level net discount on a VAT-exclusive order', lines: [L('a', 1, 50, 10)], taxForeign: 9, discountAmount: 5, totalForeign: 54, expectStatus: 'RECONCILED', expectDriftMinor: 0, expectVatGap: '-1.00' },
  { name: 'VAT-inclusive order with a GROSS order-level discount (sent with no VAT part)', lines: [L('a', 1, 100, 20)], taxForeign: 18, discountAmount: 12, pricesIncludeVat: true, totalForeign: 108, expectStatus: 'MISMATCH', expectDriftMinor: 200, expectCause: 'DISCOUNT_VAT_NOT_SPLIT' },
  { name: 'partial refund: one unit of a 3-unit line withheld, TotalVat not reduced', lines: [L('a', 3, 30, 6), L('b', 1, 10, 2)], taxForeign: 8, totalForeign: 48, refunded: { a: 1 }, expectStatus: 'MISMATCH', expectDriftMinor: 200, expectCause: 'UNEXPLAINED' },
  { name: 'fully refunded line dropped from the payload, TotalVat not reduced', lines: [L('a', 1, 30, 6), L('b', 1, 10, 2)], taxForeign: 8, totalForeign: 48, refunded: { b: 1 }, expectStatus: 'MISMATCH', expectDriftMinor: 200, expectCause: 'UNEXPLAINED' },
  // HAND-DERIVED refund boundary cases (plugin _drift_bound: half a minor unit per independently rounded amount
  // that enters the comparison; derived here by counting, NOT by the guard's or the oracle's formula).
  // Partial refund, lines a (qty 3, net 30, VAT 6) and b (qty 1, net 10, VAT 2), one unit of a refunded,
  // order VAT 6 (what the payload sends). Pushed = 20 + 10 + 6 = 36.00. Withheld = 1/3 x (30+6) = 12.00.
  // Amounts in the comparison: net a, net b, VAT total, order total (4) + net and VAT of refunded line a (2) = 6
  // => bound 3 pence. Order total 48.03 => expected 36.03, drift 3p = AT the bound: WITHIN_ROUNDING.
  { name: 'HAND partial refund: drift exactly AT the 3p bound', lines: [L('a', 3, 30, 6), L('b', 1, 10, 2)], taxForeign: 6, totalForeign: 48.03, refunded: { a: 1 }, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 3 },
  // Total 48.04 => drift 4p, one above the 3p bound: MISMATCH.
  { name: 'HAND partial refund: one pence ABOVE the 3p bound', lines: [L('a', 3, 30, 6), L('b', 1, 10, 2)], taxForeign: 6, totalForeign: 48.04, refunded: { a: 1 }, expectStatus: 'MISMATCH', expectDriftMinor: 4, expectCause: 'UNEXPLAINED' },
  // Full refund of b (qty 1, net 10, VAT 2); a (net 30, VAT 6) kept; order VAT 6. Pushed = 30 + 6 = 36.00. Withheld = 12.00.
  // Amounts: net a, VAT total, order total (3) + net and VAT of refunded b (2) = 5 => bound 2.5 pence.
  // Total 48.02 => drift 2p <= 2.5: WITHIN_ROUNDING.
  { name: 'HAND full refund: 2p, inside the 2.5p bound', lines: [L('a', 1, 30, 6), L('b', 1, 10, 2)], taxForeign: 6, totalForeign: 48.02, refunded: { b: 1 }, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 2 },
  // Total 48.03 => drift 3p > 2.5: MISMATCH (one pence above the nearest whole-pence bound).
  { name: 'HAND full refund: 3p, above the 2.5p bound', lines: [L('a', 1, 30, 6), L('b', 1, 10, 2)], taxForeign: 6, totalForeign: 48.03, refunded: { b: 1 }, expectStatus: 'MISMATCH', expectDriftMinor: 3, expectCause: 'UNEXPLAINED' },
  { name: '3dp unit price (13.498 x 3) with WC totals rounded to 2dp', lines: [L('a', 3, 40.494, 8.0988)], taxForeign: 8.1, totalForeign: 48.59, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  { name: 'unit price that does not divide (10.00 / 3)', lines: [L('a', 3, 10, 2)], taxForeign: 2, totalForeign: 12, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  { name: '9 lines: independent penny rounding accumulates to 4p, inside the 5.5p bound', lines: nineLines, taxForeign: 3, totalForeign: 17.99, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 4 },
  { name: '10 lines, 7p gap: inside the OLD bound (10.5p, counted per-line VAT) but outside the correct 6p', lines: tenLines, taxForeign: 3, totalForeign: 19.63, expectStatus: 'MISMATCH', expectDriftMinor: 7, expectCause: 'UNEXPLAINED' },
  { name: '10 lines, 6p gap: exactly on the correct 6p bound', lines: tenLines, taxForeign: 3, totalForeign: 19.64, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 6 },
  { name: 'ONE line with the same 4p gap is outside its 1.5p bound', lines: [L('a', 1, 10, 2)], taxForeign: 2, totalForeign: 12.04, expectStatus: 'MISMATCH', expectDriftMinor: 4, expectCause: 'UNEXPLAINED' },
  { name: 'one line, 1p gap: inside the 1.5p bound', lines: [L('a', 1, 10, 2)], taxForeign: 2, totalForeign: 12.01, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  { name: 'JPY (0dp): 1 yen gap on one line is inside 1.5, 2 yen is not', currency: 'JPY', lines: [L('a', 1, 1000, 100)], taxForeign: 100, totalForeign: 1101, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  { name: 'JPY (0dp): 2 yen gap', currency: 'JPY', lines: [L('a', 1, 1000, 100)], taxForeign: 100, totalForeign: 1102, expectStatus: 'MISMATCH', expectDriftMinor: 2, expectCause: 'UNEXPLAINED' },
  // KWD (3dp). The payload transmits VAT/shipping/discount rounded to 2dp, so VAT 0.004 goes out as 0.00.
  // Goods net 1.000 + transmitted VAT 0.00 = 1.000 against an order total of 1.004: 4 fils out, bound
  // (1 line net + VAT total + order total = 3 amounts) / 2 = 1.5 fils => MISMATCH.
  { name: 'KWD (3dp): VAT 0.004 is transmitted as 0.00, so the figures sent fall 4 fils short', currency: 'KWD', lines: [L('a', 1, 1.0, 0.004)], taxForeign: 0.004, totalForeign: 1.004, expectStatus: 'MISMATCH', expectDriftMinor: 4, expectCause: 'UNEXPLAINED' },
  // KWD where the transmitted figures agree: VAT 0.100 transmits exactly; 1.000 + 0.10 = 1.100 = order total.
  { name: 'KWD (3dp): VAT 0.100 transmits exactly and reconciles', currency: 'KWD', lines: [L('a', 1, 1.0, 0.1)], taxForeign: 0.1, totalForeign: 1.1, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  // JPY (0dp): 2dp transmission is harmless for whole-yen amounts: 1000 + 100 = 1100.
  { name: 'JPY (0dp): whole-yen VAT transmits exactly and reconciles', currency: 'JPY', lines: [L('a', 1, 1000, 100)], taxForeign: 100, totalForeign: 1100, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  // JPY with a fractional shipping figure the connector would transmit as 0.50: 1000 + 0.50 + 100 = 1100.50
  // against 1101: 0.50 yen => driftMinor rounds to 1 (HALF_UP), inside the 2.5 bound => WITHIN_ROUNDING.
  { name: 'JPY (0dp): fractional shipping 0.5 sent as 0.50, half a yen short', currency: 'JPY', lines: [L('a', 1, 1000, 100)], shippingForeign: 0.5, taxForeign: 100, totalForeign: 1101, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  // FLOAT-BOUNDARY shipping. The payload rounds with float Math.round: 4.015 is stored just below the half, so it
  // SENDS 4.01 (exact decimal half-up would say 4.02). One 10.00 line, no VAT, order total = 10 + half-up shipping.
  // Hand derivation: sent = 10.00 + 4.01 = 14.01 against 14.02 => 1p out; amounts in the comparison: line net,
  // shipping, VAT total, order total = 4 => bound 2p => 1p is WITHIN_ROUNDING (not RECONCILED).
  { name: 'FLOAT shipping 4.015 is SENT as 4.01 (half-up would say 4.02): 1p short', lines: [L('a', 1, 10, 0)], shippingForeign: 4.015, taxForeign: 0, totalForeign: 14.02, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  // 2.135 -> sent 2.13 (half-up 2.14): 10 + 2.13 = 12.13 vs 12.14.
  { name: 'FLOAT shipping 2.135 is SENT as 2.13 (half-up would say 2.14): 1p short', lines: [L('a', 1, 10, 0)], shippingForeign: 2.135, taxForeign: 0, totalForeign: 12.14, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  // 4.145 -> sent 4.14 (half-up 4.15): 10 + 4.14 = 14.14 vs 14.15.
  { name: 'FLOAT shipping 4.145 is SENT as 4.14 (half-up would say 4.15): 1p short', lines: [L('a', 1, 10, 0)], shippingForeign: 4.145, taxForeign: 0, totalForeign: 14.15, expectStatus: 'WITHIN_ROUNDING', expectDriftMinor: 1 },
  // 4.025 and 1.005 are the boundary values where the float rounding AGREES with half-up (Number.EPSILON nudges
  // them over the half): sent 4.03 / 1.01, so the order totals 14.03 / 11.01 reconcile.
  { name: 'FLOAT shipping 4.025 is sent as 4.03, agreeing with half-up: reconciles', lines: [L('a', 1, 10, 0)], shippingForeign: 4.025, taxForeign: 0, totalForeign: 14.03, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  { name: 'FLOAT shipping 1.005 is sent as 1.01, agreeing with half-up: reconciles', lines: [L('a', 1, 10, 0)], shippingForeign: 1.005, taxForeign: 0, totalForeign: 11.01, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  // 0.005 -> float 0.5 exactly => Math.round gives 1 => sent 0.01, AGREEING with half-up: 10 + 0.01 = 10.01.
  { name: 'FLOAT shipping 0.005 is sent as 0.01, agreeing with half-up: reconciles', lines: [L('a', 1, 10, 0)], shippingForeign: 0.005, taxForeign: 0, totalForeign: 10.01, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
  { name: 'shipping 4.01 (no rounding needed) reconciles', lines: [L('a', 1, 10, 0)], shippingForeign: 4.01, taxForeign: 0, totalForeign: 14.01, expectStatus: 'RECONCILED', expectDriftMinor: 0 },
]

/**
 * An INDEPENDENT oracle: integer ten-thousandths, no Decimal. If the guard's Decimal arithmetic and this
 * agree on the status for every fixture, the status was not produced by one shared mistake.
 */
function oracleStatus(f: Fixture, sent: Record<string, unknown>): PushTotalsVerdict['status'] {
  // Works from the TRANSMITTED payload (the real connector's output), not from the guard's inputs.
  const dp = f.currency === 'JPY' ? 0 : f.currency === 'KWD' ? 3 : 2
  const scale = 10 ** (dp + 4) // integer ten-thousandths of a minor unit
  const toInt = (x: number) => Math.round(x * scale)
  const items = sent.OrderItems as Array<{ Quantity: number; UnitPrice: number }>
  const goods = items.reduce((s, l) => s + toInt(l.Quantity * l.UnitPrice), 0)
  const pushed = goods + toInt(sent.ShippingTotalExVat as number) - toInt(sent.DiscountTotalExVat as number) + toInt(sent.TotalVat as number)
  const withheld = Object.entries(f.refunded ?? {}).reduce((s, [id, q]) => {
    const line = f.lines.find((x) => x.id === id)!
    return s + Math.round(Math.min(q, line.qty) / line.qty * toInt(line.totalForeign + line.taxForeign))
  }, 0)
  const drift = Math.abs(pushed - (toInt(f.totalForeign) - withheld))
  const minor = drift / 10 ** 4
  // Independent of the guard: counted from the FIXTURE, one half minor unit per stored amount that enters the
  // comparison (kept line nets, shipping, discount, total VAT, order total, net+VAT of each refunded line).
  const refundedLines = Object.keys(f.refunded ?? {}).length
  const keptLines = f.lines.filter((l) => (f.refunded?.[l.id] ?? 0) < l.qty).length
  const operands = keptLines + (f.shippingForeign ? 1 : 0) + (f.discountAmount ? 1 : 0) + 1 + 1 + 2 * refundedLines
  const bound = Math.min(operands / 2, MAX_ROUNDING_BOUND_MINOR_UNITS)
  if (minor < 0.5) return 'RECONCILED'
  return minor <= bound + 1e-9 ? 'WITHIN_ROUNDING' : 'MISMATCH'
}

function runFixture(f: Fixture) {
  const order = {
    id: `order-${f.name.length}`, orderNumber: 'SO-X', externalOrderNumber: null, currency: f.currency ?? 'GBP',
    customerName: 'A B', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 St', firstName: 'A', lastName: 'B' }, shippingService: null,
    subtotalForeign: 0, shippingForeign: f.shippingForeign ?? 0, taxForeign: f.taxForeign, taxRatePercent: null,
    pricesIncludeVat: f.pricesIncludeVat ?? false, discountAmount: f.discountAmount ?? 0, totalForeign: f.totalForeign,
    lines: f.lines,
    refunds: f.refunded ? [{ lines: Object.entries(f.refunded).map(([salesOrderLineId, qty]) => ({ salesOrderLineId, qty })) }] : [],
  }
  const input = buildPushInput(order, '301')
  const refundedByLine = new Map(Object.entries(f.refunded ?? {}))
  const verdict = reconcilePushTotals({
    currency: order.currency, orderTotal: order.totalForeign,
    withheldGoodsGross: withheldGoodsGross(f.lines, refundedByLine),
    withheldLineCount: withheldLineCount(f.lines, refundedByLine),
    payload: input, pricesIncludeVat: order.pricesIncludeVat,
  })
  return { order, input, verdict }
}

let ran = 0
const census: string[] = []
for (const f of FIXTURES) {
  test(`push total guard fixture: ${f.name}`, () => {
    const { input, verdict } = runFixture(f)
    ran += 1
    census.push(`${verdict.status.padEnd(15)} drift=${verdict.drift.padStart(10)} bound=${verdict.boundMinorUnits.padStart(4)} gap=${verdict.vatItemisationGap.padStart(7)} ${f.name}`)
    // Precondition: the payload really carried the lines the fixture describes (refunded ones excluded).
    const expectedPayloadLines = f.lines.filter((l) => (f.refunded?.[l.id] ?? 0) < l.qty).length
    console.log(`# precondition [${f.name}]: payloadLines=${input.lines.length} (expected ${expectedPayloadLines}) status=${verdict.status}`)
    assert.equal(input.lines.length, expectedPayloadLines)
    assert.equal(verdict.status, f.expectStatus)
    if (f.expectDriftMinor !== undefined) assert.equal(verdict.driftMinorUnits, f.expectDriftMinor)
    if (f.expectVatGap !== undefined) assert.equal(verdict.vatItemisationGap, f.expectVatGap)
    assert.equal(verdict.cause, f.expectCause ?? null)
    // Independent mechanism agrees on the status.
    assert.equal(oracleStatus(f, buildPushPayload(input, { kind: 'name' })), verdict.status)
    // The reason exists exactly when the verdict is a mismatch.
    assert.equal(verdict.reason !== null, verdict.status === 'MISMATCH')
    // What the sweep records: a finding only for a mismatch, and never 0.
    const pence = payloadTotalMismatchPence({ ...(runFixture(f).order) }, input)
    assert.equal(pence !== null, verdict.status === 'MISMATCH')
    if (pence !== null) assert.ok(pence >= 1)
  })
}

test('census: every fixture ran, and each accepted fixture honours sum(lines)+shipping-discount+VAT == total within its bound', () => {
  console.log(`# census (${ran}/${FIXTURES.length} fixtures):\n# ${census.join('\n# ')}`)
  assert.equal(ran, FIXTURES.length)
  assert.ok(FIXTURES.length >= 27)
  const flagged = FIXTURES.filter((f) => f.expectStatus === 'MISMATCH').length
  const accepted = FIXTURES.length - flagged
  console.log(`# precondition: ${accepted} accepted fixtures, ${flagged} flagged fixtures`)
  assert.ok(flagged >= 4 && accepted >= 6, 'the census must contain both outcomes, or it examines nothing')
})

test('bound scales with operands and is capped at the plugin ceiling (13 minor units)', () => {
  assert.equal(roundingBoundMinorUnits(3).toString(), '1.5')
  assert.equal(roundingBoundMinorUnits(12).toString(), '6')
  assert.equal(roundingBoundMinorUnits(81).toString(), String(MAX_ROUNDING_BOUND_MINOR_UNITS))
  const lines = Array.from({ length: 40 }, () => ({ quantity: 1, unitPriceExVat: 1, unitPriceVat: 0 }))
  const payload = { lines, totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0 }
  const at13 = reconcilePushTotals({ currency: 'GBP', orderTotal: '40.13', payload })
  const at14 = reconcilePushTotals({ currency: 'GBP', orderTotal: '40.14', payload })
  console.log(`# precondition: cap boundary 13p=${at13.status} 14p=${at14.status}`)
  assert.equal(at13.status, 'WITHIN_ROUNDING')
  assert.equal(at14.status, 'MISMATCH')
})

test('no floating-point residue: the pushed gross of 0.1 + 0.2 shaped lines is exact', () => {
  const v = reconcilePushTotals({
    currency: 'GBP', orderTotal: '0.30',
    payload: { lines: [{ quantity: 1, unitPriceExVat: 0.1, unitPriceVat: 0 }, { quantity: 1, unitPriceExVat: 0.2, unitPriceVat: 0 }], totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0 },
  })
  assert.equal(v.pushedGross, '0.300000')
  assert.equal(v.drift, '0.000000')
  assert.equal(v.status, 'RECONCILED')
})

test('withheldGoodsGross: refunds beyond the ordered quantity count only up to it; no refunds is zero', () => {
  const lines = [{ id: 'a', qty: 2, totalForeign: 20, taxForeign: 4 }, { id: 'b', qty: 0, totalForeign: 5, taxForeign: 1 }]
  assert.equal(withheldGoodsGross(lines, undefined).toString(), '0')
  assert.equal(withheldGoodsGross(lines, new Map([['a', 1]])).toString(), '12')
  assert.equal(withheldGoodsGross(lines, new Map([['a', 5]])).toString(), '24') // capped at ordered
  assert.equal(withheldGoodsGross(lines, new Map([['b', 1]])).toString(), '6') // qty 0 is treated as 1, as buildLines does
})

test('the advisory check never throws into the create path: a non-numeric total reads as no finding', () => {
  const { order, input } = runFixture(FIXTURES[0])
  const bad = { ...order, totalForeign: 'not-a-number' }
  const errors: string[] = []
  const original = console.error
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
  try {
    assert.equal(payloadTotalMismatchPence(bad, input), null)
  } finally {
    console.error = original
  }
  console.log(`# precondition: swallowed ${errors.length} error(s)`)
  assert.equal(errors.length, 1)
})

test('operator text: reasons and the page note are conditional, name no history, and give no unconditional money instruction', () => {
  const reasons = FIXTURES.map((f) => runFixture(f).verdict.reason).filter((r): r is string => r !== null)
  console.log(`# precondition: ${reasons.length} reasons checked`)
  assert.ok(reasons.length >= 4)
  for (const text of [PUSH_TOTAL_MISMATCH_OPERATOR_NOTE, ...reasons]) {
    assert.deepEqual(unconditionalMoneySentences(text), [], text)
    assert.deepEqual(unlicensedHistoryClaims(text, null), [], text)
  }
  // The cause-specific sentence appears ONLY for the cause it describes (conditional text).
  const split = reasons.filter((r) => r.includes('no VAT part'))
  assert.equal(split.length, 1)
  assert.ok(reasons.filter((r) => !r.includes('no VAT part')).length === reasons.length - 1)
})

test('exceptions page amount is scaled by the ORDER currency, not /100 GBP', () => {
  const gbp = formatMismatchAmount(200, 'GBP', 2)
  const jpy = formatMismatchAmount(200, 'JPY', 0)
  const kwd = formatMismatchAmount(2000, 'KWD', 3)
  console.log(`# precondition: ${gbp} | ${jpy} | ${kwd}`)
  assert.match(gbp, /2\.00$/)
  assert.match(jpy, /200$/)
  assert.match(kwd, /2\.000$/)
})

test('a clamped figure is shown as a lower bound, an exact one is not', () => {
  const clamped = formatMismatchAmount(MAX_ADVISORY_PENCE, 'GBP', 2)
  const exact = formatMismatchAmount(MAX_ADVISORY_PENCE - 1, 'GBP', 2)
  console.log(`# precondition: ${clamped} | ${exact} | ${formatMismatchAmount(5, 'XXX?', 2)}`)
  assert.match(clamped, /^at least /)
  assert.ok(!/^at least /.test(exact))
  assert.ok(formatMismatchAmount(5, 'not a currency', 2).includes('currency unknown'))
})

test('the guard\'s transmitted-precision constant matches what the real payload builder sends', () => {
  const input = buildPushInput(runFixture(FIXTURES[0]).order, '301')
  const sent = buildPushPayload({ ...input, totalVat: 0.004, shippingExVat: 0.004, discountExVat: 0.004 }, { kind: 'name' })
  console.log(`# precondition: sent TotalVat=${String(sent.TotalVat)} shipping=${String(sent.ShippingTotalExVat)} (constant ${PAYLOAD_TOTALS_DECIMALS}dp)`)
  assert.equal(PAYLOAD_TOTALS_DECIMALS, 2)
  assert.equal(sent.TotalVat, 0)
  assert.equal(sent.ShippingTotalExVat, 0)
  assert.equal(sent.DiscountTotalExVat, 0)
  assert.equal(buildPushPayload({ ...input, totalVat: 0.005 }, { kind: 'name' }).TotalVat, 0.01)
})

test('the float-boundary fixtures DISCRIMINATE: exact decimal half-up and the transmitted rounding disagree on them', () => {
  const cases: Array<[number, number]> = [[4.015, 4.01], [2.135, 2.13], [4.145, 4.14]]
  for (const [stored, sent] of cases) {
    const payloadValue = buildPushPayload({ ...buildPushInput(runFixture(FIXTURES[0]).order, '301'), shippingExVat: stored }, { kind: 'name' }).ShippingTotalExVat
    const halfUp = roundQuantity(stored, 2).toNumber()
    console.log(`# precondition: stored ${stored} sent ${String(payloadValue)} half-up ${halfUp}`)
    assert.equal(payloadValue, sent)
    assert.notEqual(halfUp, payloadValue)
  }
  for (const stored of [0.005, 4.025, 1.005]) {
    const agree = buildPushPayload({ ...buildPushInput(runFixture(FIXTURES[0]).order, '301'), shippingExVat: stored }, { kind: 'name' }).ShippingTotalExVat
    assert.equal(agree, roundQuantity(stored, 2).toNumber(), `control: ${stored} agrees`)
  }
})
