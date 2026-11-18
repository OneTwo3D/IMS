import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEditedExVatPrice, storedListPriceFromExVat } from '@/lib/domain/purchasing/list-price-edit'
import { resolveExVatListPrice } from '@/lib/domain/purchasing/line-margin'

test('an ex-VAT list price is stored as entered when the product stores prices ex-VAT', () => {
  const r = storedListPriceFromExVat({ exVatPrice: '12.5', storedVatInclusive: false, salesVatRate: null, productType: 'SIMPLE' })
  assert.ok(r.ok)
  assert.equal(r.ok && r.stored.toFixed(4), '12.5000')
})

test('a VAT-inclusive product stores ex-VAT x (1 + rate), and the margin reads the same ex-VAT price back', () => {
  const r = storedListPriceFromExVat({ exVatPrice: '10', storedVatInclusive: true, salesVatRate: 0.2, productType: 'VARIANT' })
  assert.ok(r.ok)
  const stored = r.ok ? r.stored.toFixed(4) : ''
  assert.equal(stored, '12.0000')
  const back = resolveExVatListPrice({ salesPrice: stored, salesPriceTaxInclusive: true, salesVatRate: 0.2 })
  assert.equal(back.kind, 'ok')
  assert.equal(back.kind === 'ok' && back.price.toDecimalPlaces(4).toFixed(), '10')
})

test('decimal maths: no binary float drift (0.1 + 0.2 style) and 4 dp half-up', () => {
  const r = storedListPriceFromExVat({ exVatPrice: '8.3332', storedVatInclusive: true, salesVatRate: 0.2, productType: 'SIMPLE' })
  assert.ok(r.ok)
  assert.equal(r.ok && r.stored.toFixed(4), '9.9998')
})

test('refusals: no VAT rate for an inclusive product, a variable parent, a bad price', () => {
  assert.deepEqual(storedListPriceFromExVat({ exVatPrice: '10', storedVatInclusive: true, salesVatRate: null, productType: 'SIMPLE' }), { ok: false, reason: 'sales-vat-unresolved' })
  assert.deepEqual(storedListPriceFromExVat({ exVatPrice: '10', storedVatInclusive: false, salesVatRate: null, productType: 'VARIABLE' }), { ok: false, reason: 'variable-parent' })
  for (const bad of ['0', '-1', '1.23456', 'abc', '', '123456789']) {
    assert.deepEqual(storedListPriceFromExVat({ exVatPrice: bad, storedVatInclusive: false, salesVatRate: null, productType: 'SIMPLE' }), { ok: false, reason: 'invalid-price' }, bad)
  }
  assert.equal(parseEditedExVatPrice(' 7.25 '), '7.25')
})
