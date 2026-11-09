import assert from 'node:assert/strict'
import test from 'node:test'

import { computeSchemePostingDrift } from '@/lib/connectors/xero/scheme-posting-drift'
import { buildDriftSnapshot, sweepTaxRateDrift } from '@/lib/connectors/xero/tax-rate-drift-sweeper'
import { xeroType } from '../tax/eu-vat-fixtures'

const names = new Map([['TAX131', 'DE IOSS VAT']])
const rate = (patch: Partial<{ schemePostingTaxType: string; reportingCategory: string | null; accountingTaxType: string | null }> = {}) => ({ taxRateId: 'r1', name: 'DE VAT', schemePostingTaxType: 'TAX131', reportingCategory: 'IOSS', accountingTaxType: 'TAX007', ...patch })

test('a posting type that is ACTIVE, at 0 and named as declared is not drift', () => {
  assert.deepEqual(computeSchemePostingDrift([rate()], [xeroType('TAX131', 'DE IOSS VAT', '0.0000')], names), [])
})

test('each way a posting type can drift is reported, by code', () => {
  const run = (xero: ReturnType<typeof xeroType>[], r = rate()): string[] => computeSchemePostingDrift([r], xero, names).flatMap((d) => d.lines)
  assert.match(run([])[0]!, /not in the Xero tax-rate list/)
  assert.match(run([xeroType('TAX131', 'DE IOSS VAT', '0.0000', 'ARCHIVED')])[0]!, /ARCHIVED in Xero, not ACTIVE/)
  assert.match(run([xeroType('TAX131', 'DE IOSS VAT', '19.0000')])[0]!, /19% in Xero, not 0%/)
  assert.match(run([{ ...xeroType('TAX131', 'DE IOSS VAT', '0.0000'), effectiveRate: null, displayTaxRate: null }])[0]!, /states no rate/)
  assert.match(run([xeroType('TAX131', 'DE IOSS  VAT', '0.0000')])[0]!, /named "DE IOSS  VAT" in Xero, declared "DE IOSS VAT"/)
  assert.match(run([xeroType('TAX131', 'DE IOSS VAT', '0.0000')], rate({ reportingCategory: null }))[0]!, /not IOSS or VOEC/)
  assert.match(run([xeroType('TAX131', 'DE IOSS VAT', '0.0000')], rate({ accountingTaxType: 'TAX131' }))[0]!, /post on the charged rate/)
})

test('the sweep reports it even for a rate with no components, records it, and the snapshot holds one entry per rate with the lines of both checks', async () => {
  const recorded: string[] = []
  const result = await sweepTaxRateDrift({
    loadImsProfiles: async () => [],
    fetchXeroTaxRates: async () => { throw new Error('no Xero call for an empty profile list') },
    checkSchemePosting: async () => computeSchemePostingDrift([rate()], [xeroType('TAX131', 'DE IOSS VAT', '19.0000')], names),
    recordDrift: async (item) => { recorded.push(item.taxRateId) },
  })
  assert.equal(result.drifted, 1)
  assert.deepEqual(recorded, ['r1'])
  assert.equal(buildDriftSnapshot(result).length, 1)

  const both = await sweepTaxRateDrift({
    loadImsProfiles: async () => [{ taxRateId: 'r1', profile: { name: 'DE VAT', components: [{ name: 'VAT', rate: 0.19, compoundOnPrevious: false }] } }],
    fetchXeroTaxRates: async () => [{ Name: 'DE VAT', TaxComponents: [{ Name: 'VAT', Rate: 20, IsCompound: false }] }] as never,
    checkSchemePosting: async () => computeSchemePostingDrift([rate()], [xeroType('TAX131', 'DE IOSS VAT', '19.0000')], names),
    recordDrift: async () => undefined,
  })
  const snapshot = buildDriftSnapshot(both)
  assert.equal(snapshot.length, 1, 'one entry per rate')
  assert.equal(snapshot[0]!.lines.length, 2)
  assert.match(snapshot[0]!.lines.join(' | '), /Scheme posting type TAX131 is 19%.*\|.*component rate: IMS 19%, Xero 20%/)
})

test('without the scheme check the sweep is what it was', async () => {
  const result = await sweepTaxRateDrift({ loadImsProfiles: async () => [], fetchXeroTaxRates: async () => [], recordDrift: async () => undefined })
  assert.deepEqual(result, { checked: 0, drifted: 0, items: [] })
})
