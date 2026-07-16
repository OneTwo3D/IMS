import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Resolving a WooCommerce tax rate has two failure shapes that used to look identical, because
 * both produced the same wordless 0% (o3d-6ec):
 *
 *   - the order names NO rate      -> WooCommerce says there is no tax, so 0% is CORRECT;
 *   - the order names a rate we cannot map -> we do not know the tax, and 0% is a GUESS.
 *
 * The second is how VAT goes missing without anyone noticing: WooCommerce charges 20%, the IMS
 * records 0%, the invoice posts with no TaxType, and nothing anywhere says a word. Both
 * instances shipped with `isDefault` on an INACTIVE rate, so the "no usable default" branch was
 * live rather than theoretical.
 *
 * These pin that the honest case stays quiet and the dangerous one is impossible to miss — a
 * check that shouts at both would just get muted.
 */

const logs: Array<{ level?: string; action?: string; description?: string; metadata?: Record<string, unknown> }> = []
let defaultRate: unknown = null
let mapping: unknown = null

mock.module('@/lib/db', {
  namedExports: {
    db: {
      taxRate: { findFirst: async () => defaultRate },
      shoppingTaxRateMapping: { findUnique: async () => mapping },
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (e: (typeof logs)[number]) => { logs.push(e) } },
})

// Lazily imported: tsx transpiles this to CJS, where a top-level await will not compile.
// The mocks above are registered before any test body runs, so the first call still gets them.
type Resolver = (id: number | null) => Promise<{
  taxRateValue: number; accountingTaxType: string | null; source: string
}>
let resolve: Resolver | null = null
const resolveWcTaxRateById: Resolver = async (id) => {
  if (!resolve) {
    const m = await import('@/lib/connectors/woocommerce/sync/field-mapping')
    resolve = m.resolveWcTaxRateById as unknown as Resolver
  }
  return resolve(id)
}

const UK_VAT = { id: 'r1', name: 'UK VAT', rate: 0.2, accountingTaxType: 'OUTPUT2', reverseCharge: false }

test.beforeEach(() => {
  logs.length = 0
  defaultRate = null
  mapping = null
})

test('a mapped WC rate resolves to it, and says nothing', async () => {
  mapping = { taxRate: UK_VAT }
  const r = await resolveWcTaxRateById(112)
  assert.equal(r.taxRateValue, 0.2)
  assert.equal(r.accountingTaxType, 'OUTPUT2')
  assert.equal(r.source, 'mapped')
  assert.deepEqual(logs, [], 'the normal path must be silent')
})

test('an order naming NO tax rate is silent — 0% is correct, not a guess', async () => {
  // WooCommerce is the authority: no rate means no tax. Logging here would be noise on every
  // untaxed order, and noise is how the real warning below gets ignored.
  const r = await resolveWcTaxRateById(null)
  assert.equal(r.taxRateValue, 0)
  assert.deepEqual(logs, [], 'no tax is not a fault')
})

test('an UNMAPPED WC rate WARNS that the rate was substituted', async () => {
  // WooCommerce charged tax at a rate we cannot map. Returning the default is a substitution,
  // and it has to say so — this is the silence that let VAT go missing.
  defaultRate = UK_VAT
  mapping = null
  const r = await resolveWcTaxRateById(999)

  assert.equal(r.taxRateValue, 0.2, 'substitutes the default rather than inventing 0%')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'WARNING')
  assert.equal(logs[0].action, 'wc_tax_rate_unmapped')
  assert.match(logs[0].description ?? '', /999/, 'name the WC rate, or nobody can fix the mapping')
  assert.equal(logs[0].metadata?.externalTaxRateId, 999)
})

test('an UNMAPPED WC rate with NO usable default is an ERROR, not a warning', async () => {
  // The worst case, and the one both instances shipped in: we record 0% VAT for a line
  // WooCommerce taxed, with no tax type, and it posts to the ledger that way. That belongs on
  // the error dashboard, not in a log nobody greps.
  defaultRate = null
  mapping = null
  const r = await resolveWcTaxRateById(999)

  assert.equal(r.taxRateValue, 0)
  assert.equal(r.accountingTaxType, null)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'ERROR', 'recorded VAT we know to be wrong — ERROR, not WARNING')
  assert.equal(logs[0].action, 'wc_tax_rate_unresolvable')
  assert.match(logs[0].description ?? '', /0% VAT/)
})

test('no default AND no rate named stays silent — an untaxed order is not a fault', async () => {
  // The pair of the case above: same missing default, but WooCommerce named no rate, so there
  // is nothing to be wrong about. Only the combination with an unmapped rate is a fault.
  defaultRate = null
  const r = await resolveWcTaxRateById(null)
  assert.equal(r.taxRateValue, 0)
  assert.deepEqual(logs, [], 'a missing default only matters when something needed it')
})
