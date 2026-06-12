import assert from 'node:assert/strict'
import { test } from 'node:test'
import { multiComponentTaxRateNames } from '@/lib/accounting/multi-component-warning'

test('returns empty array when no lines have a taxRate', () => {
  assert.deepEqual(multiComponentTaxRateNames([{ taxRate: null }, { taxRate: null }]), [])
})

test('returns empty array when taxRates have no components and are not compound', () => {
  assert.deepEqual(
    multiComponentTaxRateNames([
      { taxRate: { name: 'UK 20%', isCompound: false, components: [] } },
      { taxRate: { name: 'EU 0%', isCompound: false, components: [] } },
    ]),
    [],
  )
})

test('returns rate names for lines with at least one active component', () => {
  assert.deepEqual(
    multiComponentTaxRateNames([
      { taxRate: { name: 'GST+PST 12%', isCompound: false, components: [{ id: 'gst' }] } },
      { taxRate: { name: 'UK 20%', isCompound: false, components: [] } },
    ]),
    ['GST+PST 12%'],
  )
})

test('returns rate names for compound taxRates even with no probed components', () => {
  // isCompound is the legacy flag on the parent; some older rows have it set
  // without components materialized via the active-only probe. Both shapes
  // should fire the warning.
  assert.deepEqual(
    multiComponentTaxRateNames([
      { taxRate: { name: 'Quebec QST', isCompound: true, components: [] } },
    ]),
    ['Quebec QST'],
  )
})

test('deduplicates and sorts rate names across multiple lines', () => {
  assert.deepEqual(
    multiComponentTaxRateNames([
      { taxRate: { name: 'GST+PST 12%', isCompound: false, components: [{ id: 'gst' }] } },
      { taxRate: { name: 'Quebec QST', isCompound: true, components: [] } },
      { taxRate: { name: 'GST+PST 12%', isCompound: false, components: [{ id: 'gst' }] } },
    ]),
    ['GST+PST 12%', 'Quebec QST'],
  )
})

test('skips taxRates with null name', () => {
  assert.deepEqual(
    multiComponentTaxRateNames([
      { taxRate: { name: null, isCompound: true, components: [] } },
    ]),
    [],
  )
})
