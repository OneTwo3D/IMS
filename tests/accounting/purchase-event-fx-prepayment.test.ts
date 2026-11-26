import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  XERO_PREPAYMENTS_PAGE_SIZE,
  readXeroSupplierPrepaymentsByReference,
  xeroCurrencyRateToImsRateToBase,
  type PrepaymentReadDeps,
  type XeroSupplierPrepayment,
} from '@/lib/connectors/xero/prepayments'
import { PurchaseFxRefusalError, goodsUnitCostsAtRate, isTransientPurchaseFxRefusal, matchSupplierPrepayment } from '@/lib/domain/purchasing/purchase-receipt-fx'
import { MissingFxRateError } from '@/lib/currencies/fx-select'
import { allocateLandedCost, grossUnitCostForGoods } from '@/lib/domain/purchasing/landed-cost-allocation'
import { layerUnitCostAfterRecalc } from '@/lib/domain/purchasing/landed-cost-service'

/**
 * o3d-hqvrp.51 step 2 (per-event FX rates for purchasing): the read-only Xero supplier prepayment reader, the matching rule, the rate direction
 * and the goods valuation. A FAKE LEDGER: every Xero answer below is a canned response handed to the reader's injected `get`; nothing touches the
 * network.
 */

const TENANT = 'tenant-1'
const D = (value: string | number) => new Prisma.Decimal(value)

function fakeLedger(response: { ok?: boolean; status?: number; data?: unknown; error?: string; tenantId?: string }): { deps: PrepaymentReadDeps; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    deps: {
      get: async <T>(path: string) => {
        paths.push(path)
        return { ok: response.ok ?? true, status: response.status ?? 200, data: response.data as T, error: response.error, tenantId: 'tenantId' in response ? response.tenantId : TENANT }
      },
    },
  }
}

function spend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PrepaymentID: 'pp-1',
    Type: 'SPEND-PREPAYMENT',
    Status: 'AUTHORISED',
    Reference: 'PO-2026-0042',
    Contact: { ContactID: 'contact-supplier' },
    CurrencyCode: 'USD',
    CurrencyRate: 1.352650993,
    Total: 3908.95,
    DateString: '2026-09-07T00:00:00',
    ...overrides,
  }
}

// ─── the rate direction ─────────────────────────────────────────────────────────────────────────────────────────

test('rate direction: Xero CurrencyRate is foreign per 1 base, the same as IMS fxRateToBase, so the conversion is the identity', () => {
  // Live GBP organisation, 2026-11-22 (read only): a USD bill carries 1.352650993, a CNY bill 8.937375334, a EUR bill 1.1835295458. IMS fx_rates
  // holds USD at 1.3125 the same day: both say "1 GBP = 1.3 USD".
  assert.equal(xeroCurrencyRateToImsRateToBase(1.352650993)!.toString(), '1.352650993')
  assert.equal(xeroCurrencyRateToImsRateToBase('8.937375334')!.toString(), '8.937375334')
  assert.equal(xeroCurrencyRateToImsRateToBase(1.1835295458)!.toString(), '1.1835295458')
})

test('rate direction, forward: 100 USD of goods at CurrencyRate 1.25 is GBP 80.00 (base = foreign / rate), never GBP 125', () => {
  const rate = xeroCurrencyRateToImsRateToBase(1.25)!
  const goods = goodsUnitCostsAtRate({ subtotalForeign: '100', lines: [{ id: 'l1', unitCostForeign: '100', totalForeign: '100' }] }, rate)
  assert.equal(goods.get('l1')!.toString(), '80')
  assert.notEqual(goods.get('l1')!.toString(), '125')
})

test('rate direction, backward: the base value times the rate gives the foreign amount back (live USD prepayment, exact Decimal)', () => {
  const rate = xeroCurrencyRateToImsRateToBase(1.352650993)!
  const foreign = D('3908.95')
  const base = foreign.div(rate)
  assert.equal(base.toDecimalPlaces(2).toString(), '2889.84')
  assert.equal(base.mul(rate).toDecimalPlaces(10).toString(), '3908.95')
})

test('rate parse: refuses zero, negative, non-numeric, exponent forms and more precision than can be stored exactly', () => {
  for (const bad of [0, -1.2, '0', 'abc', '', null, undefined, Number.NaN, 1e-7, '1.1234567890123', '1234567890.1234567']) {
    assert.equal(xeroCurrencyRateToImsRateToBase(bad), null, `refused: ${String(bad)}`)
  }
  assert.equal(xeroCurrencyRateToImsRateToBase('1.123456789012')!.toString(), '1.123456789012')
})

// ─── the reader against a fake ledger ───────────────────────────────────────────────────────────────────────────

test('reader: asks the Prepayments endpoint once, by Reference, and reads a SPEND prepayment in full', async () => {
  const ledger = fakeLedger({ data: { Prepayments: [spend()] } })
  const read = await readXeroSupplierPrepaymentsByReference('PO-2026-0042', ledger.deps)
  assert.equal(ledger.paths.length, 1)
  assert.equal(ledger.paths[0], `Prepayments?where=${encodeURIComponent('Reference=="PO-2026-0042"')}&page=1`)
  assert.ok(read.ok)
  assert.equal(read.tenantId, TENANT)
  assert.equal(read.prepayments.length, 1)
  const [row] = read.prepayments
  assert.deepEqual({ ...row, currencyRate: row!.currencyRate.toString(), total: row!.total.toString() }, {
    prepaymentId: 'pp-1', status: 'AUTHORISED', reference: 'PO-2026-0042', contactId: 'contact-supplier', currencyCode: 'USD',
    currencyRate: '1.352650993', total: '3908.95', date: '2026-09-07',
  })
})

test('reader: sets aside RECEIVE prepayments, voided and deleted ones, and rows whose reference is not the order\'s', async () => {
  const ledger = fakeLedger({ data: { Prepayments: [
    spend({ PrepaymentID: 'recv', Type: 'RECEIVE-PREPAYMENT' }),
    spend({ PrepaymentID: 'void', Status: 'VOIDED' }),
    spend({ PrepaymentID: 'del', Status: 'DELETED' }),
    spend({ PrepaymentID: 'other', Reference: 'PO-2026-0043' }),
    spend({ PrepaymentID: 'case', Reference: ' po-2026-0042 ' }),
  ] } })
  const read = await readXeroSupplierPrepaymentsByReference('PO-2026-0042', ledger.deps)
  assert.ok(read.ok)
  assert.deepEqual(read.prepayments.map((p) => p.prepaymentId), ['case'])
})

test('reader: the legacy /Date(ms)/ form is read when DateString is absent', async () => {
  const ledger = fakeLedger({ data: { Prepayments: [spend({ DateString: undefined, Date: '/Date(1788739200000+0000)/' })] } })
  const read = await readXeroSupplierPrepaymentsByReference('PO-2026-0042', ledger.deps)
  assert.ok(read.ok)
  assert.equal(read.prepayments[0]!.date, new Date(1788739200000).toISOString().slice(0, 10))
})

test('reader: fail closed - a failed request, no Prepayments list, no organisation named, a full page, a half-readable row', async () => {
  const cases: Array<[string, Parameters<typeof fakeLedger>[0]]> = [
    ['http', { ok: false, status: 503, error: 'Service unavailable' }],
    ['shape', { data: {} }],
    ['tenant', { data: { Prepayments: [] }, tenantId: undefined }],
    ['page', { data: { Prepayments: Array.from({ length: XERO_PREPAYMENTS_PAGE_SIZE }, (_, i) => spend({ PrepaymentID: `p${i}` })) } }],
    ['rate', { data: { Prepayments: [spend({ CurrencyRate: 0 })] } }],
    ['contact', { data: { Prepayments: [spend({ Contact: null })] } }],
    ['date', { data: { Prepayments: [spend({ DateString: 'yesterday', Date: undefined })] } }],
  ]
  for (const [label, response] of cases) {
    const read = await readXeroSupplierPrepaymentsByReference('PO-2026-0042', fakeLedger(response).deps)
    assert.equal(read.ok, false, `${label} must be an error, never "no prepayment"`)
  }
  const threw = await readXeroSupplierPrepaymentsByReference('PO-1', { get: async () => { throw new Error('socket') } })
  assert.equal(threw.ok, false)
})

test('reader: a reference with a quote or backslash is refused before anything is sent', async () => {
  const ledger = fakeLedger({ data: { Prepayments: [] } })
  const read = await readXeroSupplierPrepaymentsByReference('PO-"1"', ledger.deps)
  assert.equal(read.ok, false)
  assert.equal(ledger.paths.length, 0)
})

// ─── the matching rule ──────────────────────────────────────────────────────────────────────────────────────────

const prepayment = (overrides: Partial<XeroSupplierPrepayment> = {}): XeroSupplierPrepayment => ({
  prepaymentId: 'pp-1', status: 'AUTHORISED', reference: 'PO-1', contactId: 'c-1', currencyCode: 'USD', currencyRate: D('1.3'), total: D('100'), date: '2026-11-01',
  ...overrides,
})

test('match: none, found, and every refusal (several, wrong currency, wrong contact, supplier not linked)', () => {
  const base = { poReference: 'PO-1', poCurrency: 'usd', supplierContactId: 'c-1' }
  assert.deepEqual(matchSupplierPrepayment({ ...base, prepayments: [] }), { kind: 'none' })
  const found = matchSupplierPrepayment({ ...base, prepayments: [prepayment()] })
  assert.equal(found.kind, 'found')
  const several = matchSupplierPrepayment({ ...base, prepayments: [prepayment(), prepayment({ prepaymentId: 'pp-2' })] })
  assert.equal(several.kind, 'refused')
  assert.match((several as { reason: string }).reason, /2 Xero supplier prepayments.*pp-1, pp-2/)
  assert.equal(matchSupplierPrepayment({ ...base, prepayments: [prepayment({ currencyCode: 'EUR' })] }).kind, 'refused')
  assert.equal(matchSupplierPrepayment({ ...base, prepayments: [prepayment({ contactId: 'c-2' })] }).kind, 'refused')
  assert.equal(matchSupplierPrepayment({ ...base, supplierContactId: null, prepayments: [prepayment()] }).kind, 'refused')
})

// ─── the goods valuation and the per-layer landed cost ──────────────────────────────────────────────────────────

test('goods valuation: unit cost foreign x the FOREIGN header-discount factor / rate, 6dp HALF_UP', () => {
  // Two lines, 100 + 300 foreign, a header discount to 360 (factor 0.9), rate 1.3.
  const goods = goodsUnitCostsAtRate({
    subtotalForeign: '360',
    lines: [{ id: 'a', unitCostForeign: '10', totalForeign: '100' }, { id: 'b', unitCostForeign: '30', totalForeign: '300' }],
  }, D('1.3'))
  assert.equal(goods.get('a')!.toString(), D(10).mul('0.9').div('1.3').toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toString())
  assert.equal(goods.get('a')!.toString(), '6.923077')
  assert.equal(goods.get('b')!.toString(), '20.769231')
})

test('allocation: a goodsUnitCostBase override replaces the PO goods cost and keeps the freight share; absent = unchanged', () => {
  const lines = [{ id: 'a', qty: 4, unitCostBase: 10, totalBase: 40 }]
  const freight = [{ amountBase: 8, distributionMethod: 'BY_VALUE', sourceRank: 0 as const }]
  assert.equal(allocateLandedCost(lines, freight).grossUnitCostBaseByLine.get('a')!.toString(), '12')
  const locked = allocateLandedCost([{ ...lines[0]!, goodsUnitCostBase: '9.5' }], freight)
  assert.equal(locked.grossUnitCostBaseByLine.get('a')!.toString(), '11.5')
  assert.equal(grossUnitCostForGoods('9.5', 8, 4).gross.toString(), '11.5')
})

test('per-layer recalc: a legacy NULL layer takes the line gross and floor exactly; a rate-locked layer keeps its goods and takes the new share', () => {
  const lineFloor = { lineId: 'a', qty: D(4), unflooredGrossUnitCostBase: D(-1), unabsorbedPerUnitBase: D(1) }
  const legacy = layerUnitCostAfterRecalc({ layerGoodsUnitCostBase: null, lineGrossUnitCostBase: D('12'), lineLandedAmountBase: D(8), allocationQty: D(4), lineFloor, lineId: 'a' })
  assert.equal(legacy.newUnitCost.toString(), '12')
  assert.equal(legacy.floor, lineFloor)
  const locked = layerUnitCostAfterRecalc({ layerGoodsUnitCostBase: '9.5', lineGrossUnitCostBase: D('12'), lineLandedAmountBase: D(8), allocationQty: D(4), lineFloor: undefined, lineId: 'a' })
  assert.equal(locked.newUnitCost.toString(), '11.5')
  assert.equal(locked.floor, undefined)
  const credit = layerUnitCostAfterRecalc({ layerGoodsUnitCostBase: '1', lineGrossUnitCostBase: D('0'), lineLandedAmountBase: D(-8), allocationQty: D(4), lineFloor: undefined, lineId: 'a' })
  assert.equal(credit.newUnitCost.toString(), '0')
  assert.equal(credit.floor?.unflooredGrossUnitCostBase.toString(), '-1')
  const noQty = layerUnitCostAfterRecalc({ layerGoodsUnitCostBase: '9.5', lineGrossUnitCostBase: D('12'), lineLandedAmountBase: D(0), allocationQty: D(0), lineFloor: undefined, lineId: 'a' })
  assert.equal(noQty.newUnitCost.toString(), '9.5')
})

// ─── MED-4 / MED-6 (the step-2 review follow-ups) ────────────────────────────────────────────────────────────────

test('MED-4: only a transient purchase FX refusal (or a missing fx_rates rate) is waited out; ambiguity and anything else counts', () => {
  assert.equal(isTransientPurchaseFxRefusal(new PurchaseFxRefusalError('x', { transient: true })), true)
  assert.equal(isTransientPurchaseFxRefusal(new PurchaseFxRefusalError('x')), false, 'default: real ambiguity')
  assert.equal(isTransientPurchaseFxRefusal(new MissingFxRateError('Missing GBP FX rate', 'USD', undefined)), true, 'a missing table rate waits for the rate')
  assert.equal(isTransientPurchaseFxRefusal(new Error('boom')), false)
  assert.equal(isTransientPurchaseFxRefusal('Missing rate'), false)
})

test('MED-6: the unlinked-supplier refusal names the real remedy (there is no screen to set the contact)', () => {
  const out = matchSupplierPrepayment({
    poReference: 'PO-1', poCurrency: 'USD', supplierContactId: null,
    prepayments: [{ prepaymentId: 'pp-1', status: 'AUTHORISED', reference: 'PO-1', contactId: 'c1', currencyCode: 'USD', currencyRate: new Prisma.Decimal('1.3'), total: new Prisma.Decimal('10'), date: '2026-11-20' }],
  })
  assert.equal(out.kind, 'refused')
  if (out.kind === 'refused') {
    assert.match(out.reason, /not linked to a Xero contact of this organisation/)
    assert.match(out.reason, /exactly the supplier's name \(or email\)/)
    assert.doesNotMatch(out.reason, /or set the contact/)
  }
})
