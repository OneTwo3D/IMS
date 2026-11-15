import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * SIDE-EFFECT-FREE TAX RESOLUTION FOR THE SHADOW BUILD. An unmapped WooCommerce rate logs to the activity log in the importer; inside `collectingUnmappedWcRates` it logs NOTHING and is reported, so the shadow
 * build can refuse the order as `unmapped_tax_rate` instead of building it on a silently substituted default rate.
 */
const logged: unknown[] = []
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (p: unknown) => { logged.push(p) }, logActivityPersisted: async () => true, logActivityInTransaction: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingTaxRateMapping: { findUnique: async ({ where }: { where: { connector_externalTaxRateId: { externalTaxRateId: string } } }) => (where.connector_externalTaxRateId.externalTaxRateId === '7' ? { taxRate: { id: 'r7', name: 'DE VAT', rate: 0.19, accountingTaxType: 'OUT', reverseCharge: false, active: true } } : null) },
      taxRate: { findFirst: async () => ({ id: 'def', name: 'UK VAT', rate: 0.2, accountingTaxType: 'OUTPUT2', reverseCharge: false }) },
    },
  },
})

test('inside the collector an unmapped rate is recorded, not logged; mapped rates are untouched; outside it still logs', async () => {
  const { collectingUnmappedWcRates, resolveWcTaxRateById } = await import('../../lib/connectors/woocommerce/sync/field-mapping')
  const { result, unmapped } = await collectingUnmappedWcRates(async () => [await resolveWcTaxRateById(7), await resolveWcTaxRateById(99), await resolveWcTaxRateById(null)])
  assert.deepEqual(unmapped, [99])
  assert.equal(result[0]!.source, 'mapped')
  assert.deepEqual(logged, [], 'nothing was logged')
  await resolveWcTaxRateById(99)
  assert.equal(logged.length, 1, 'the importer still logs the substitution loudly')
})
