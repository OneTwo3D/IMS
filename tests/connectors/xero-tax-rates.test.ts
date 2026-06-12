import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildXeroTaxRatePayload } from '@/lib/connectors/xero/tax-rates'

test('converts IMS decimal rates to Xero percent and preserves component order', () => {
  const payload = buildXeroTaxRatePayload({
    name: 'GST+PST 12%',
    reportTaxType: 'OUTPUT',
    components: [
      { name: 'GST', rate: 0.05, compoundOnPrevious: false },
      { name: 'PST', rate: 0.07, compoundOnPrevious: true },
    ],
  })
  assert.equal(payload.Name, 'GST+PST 12%')
  assert.equal(payload.ReportTaxType, 'OUTPUT')
  assert.deepEqual(payload.TaxComponents, [
    { Name: 'GST', Rate: 5, IsCompound: undefined },
    { Name: 'PST', Rate: 7, IsCompound: true },
  ])
  assert.equal(payload.Status, 'ACTIVE')
})

test('omits IsCompound for non-compound components instead of sending false', () => {
  const payload = buildXeroTaxRatePayload({
    name: 'UK Standard 20%',
    components: [{ name: 'VAT', rate: 0.2, compoundOnPrevious: false }],
  })
  // Xero rejects unknown explicit `false` on some fields; safer to omit.
  assert.equal(payload.TaxComponents[0]?.IsCompound, undefined)
})

test('rounds high-precision IMS rates to 4 decimal places of percent', () => {
  // IMS allows 4dp decimals (Decimal(5,4)) which become 6dp when converted
  // to percent — Xero's API accepts that precision but clamping here keeps
  // payloads readable and stable across re-syncs.
  const payload = buildXeroTaxRatePayload({
    name: 'Custom 1.2345%',
    components: [{ name: 'Custom', rate: 0.012345, compoundOnPrevious: false }],
  })
  assert.equal(payload.TaxComponents[0]?.Rate, 1.2345)
})

test('defaults status to ACTIVE and omits reportTaxType when not provided', () => {
  const payload = buildXeroTaxRatePayload({
    name: 'Default',
    components: [{ name: 'A', rate: 0.1, compoundOnPrevious: false }],
  })
  assert.equal(payload.Status, 'ACTIVE')
  assert.equal(payload.ReportTaxType, undefined)
})

test('honors ARCHIVED status when archiving a deprecated TaxRate', () => {
  const payload = buildXeroTaxRatePayload({
    name: 'Old Rate',
    components: [{ name: 'A', rate: 0.05, compoundOnPrevious: false }],
    status: 'ARCHIVED',
  })
  assert.equal(payload.Status, 'ARCHIVED')
})
