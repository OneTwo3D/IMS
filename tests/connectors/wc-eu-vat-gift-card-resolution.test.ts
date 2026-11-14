import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { resolveEuVatRegime } from '@/lib/domain/accounting/eu-vat-regime'
import { buildEuVatRegimeInput, readGoodsLines, type EuVatRegimeInputClient } from '@/lib/connectors/woocommerce/sync/eu-vat-facts'
import { applyGiftCardLineResolutions } from '@/lib/connectors/woocommerce/sync/gift-card-line-resolution'
import type { WcFullOrder, WcMeta } from '@/lib/connectors/woocommerce/sync/types'

const meta = (key: string, value: unknown): WcMeta => ({ id: 1, key, value })
const CUT_IN = { state: 'ok' as const, at: new Date('2026-10-01T00:00:00Z') }
const ACCOUNTS = { ioss: '821', ddp: '232' }

function order(lines: Array<{ id: number; flag?: unknown }>): WcFullOrder {
  return {
    id: 77, number: '77', currency: 'EUR', date_created: '2026-11-01T10:00:00', date_created_gmt: '2026-11-01T10:00:00', total: '119.00', total_tax: '19.00',
    billing: { country: 'DE' }, shipping: { country: 'DE' }, meta_data: [],
    line_items: lines.map((l) => ({ id: l.id, total: '50.00', meta_data: l.flag === undefined ? [] : [meta('_o3d_is_voucher', l.flag)] })),
    tax_lines: [{ id: 1, rate_id: 216, rate_code: 'x', label: 'DE', compound: false, tax_total: '17.00', shipping_tax_total: '2.00' }],
    shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
  } as unknown as WcFullOrder
}

function client(answers: Array<{ externalLineItemId: number; isGiftCard: boolean }> | null): EuVatRegimeInputClient {
  const fetchedAt = new Date('2026-10-31T12:00:00Z')
  const asked: unknown[] = []
  const base = {
    shoppingTaxRateMapping: { findMany: (async () => [{ externalTaxRateId: '216', taxRate: { id: 'ims-216', name: 'DE VAT', rate: new Prisma.Decimal('0.19'), active: true, countryCode: 'de', reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' } }]) as never },
    fxRate: { groupBy: (async () => [{ toCurrency: 'EUR', _max: { fetchedAt } }]) as never, findMany: (async () => []) as never },
    setting: { findMany: (async () => []) as never },
  }
  return (answers === null ? base : { ...base, euVatGiftCardLineResolution: { findMany: (async (args: unknown) => { asked.push(args); return answers }) as never } }) as unknown as EuVatRegimeInputClient
}
const decision = async (c: EuVatRegimeInputClient, o: WcFullOrder) => resolveEuVatRegime(await buildEuVatRegimeInput(c, o, ACCOUNTS, { baseCurrency: 'EUR', mode: 'decide', giftCardCutIn: CUT_IN })) as { kind: string; code?: string; giftCardLineIds?: number[] }

test('a goods line carries the store id of its order line', () => {
  assert.deepEqual(readGoodsLines(order([{ id: 11, flag: 'no' }, { id: 12 }])).map((l) => l.lineId), [11, 12])
})

test('an unsettled line refuses with the store ids of the lines to answer for, and only those', async () => {
  const d = await decision(client([]), order([{ id: 11, flag: 'no' }, { id: 12 }, { id: 13, flag: 'unknown' }]))
  assert.equal(d.code, 'gift_card_flag_missing')
  assert.deepEqual(d.giftCardLineIds, [12, 13])
})

test('an unknown line stays refusing with no answer, and with a client that cannot read answers (no silent default)', async () => {
  const o = order([{ id: 11, flag: 'no' }, { id: 12, flag: 'unknown' }])
  assert.equal((await decision(client([]), o)).code, 'gift_card_flag_missing')
  assert.equal((await decision(client(null), o)).code, 'gift_card_flag_missing')
})

test('an answer for a line settles it, either way, and the order no longer refuses for the flag', async () => {
  const o = order([{ id: 11, flag: 'no' }, { id: 12, flag: 'unknown' }])
  assert.notEqual((await decision(client([{ externalLineItemId: 12, isGiftCard: false }]), o)).code, 'gift_card_flag_missing')
  assert.notEqual((await decision(client([{ externalLineItemId: 12, isGiftCard: true }]), o)).code, 'gift_card_flag_missing')
})

test('an answer for one line does not settle another', async () => {
  const o = order([{ id: 12, flag: 'unknown' }, { id: 13 }])
  const d = await decision(client([{ externalLineItemId: 12, isGiftCard: false }]), o)
  assert.equal(d.code, 'gift_card_flag_missing')
  assert.deepEqual(d.giftCardLineIds, [13])
})

test('an answer never overrides a flag the store did settle', () => {
  const lines = readGoodsLines(order([{ id: 11, flag: 'yes' }, { id: 12, flag: 'no' }, { id: 13, flag: 'unknown' }]))
  const applied = applyGiftCardLineResolutions(lines, new Map([[11, false], [12, true], [13, true]]))
  assert.deepEqual(applied.map((l) => l.voucherStrict), ['yes', 'no', 'yes'])
  assert.deepEqual(applied.map((l) => l.voucher), ['yes', 'no', 'yes'])
})

test('the answer table is read only for an order with an unsettled line', async () => {
  let reads = 0
  const c = client([]) as unknown as { euVatGiftCardLineResolution: { findMany: () => Promise<unknown[]> } }
  const counted = { ...c, euVatGiftCardLineResolution: { findMany: async () => { reads += 1; return [] } } } as unknown as EuVatRegimeInputClient
  await decision(counted, order([{ id: 11, flag: 'no' }]))
  assert.equal(reads, 0)
  await decision(counted, order([{ id: 11, flag: 'no' }, { id: 12 }]))
  assert.equal(reads, 1)
})
