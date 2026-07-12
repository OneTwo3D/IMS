import assert from 'node:assert/strict'
import test from 'node:test'

import { xeroReportTaxType, XERO_REPORT_TAX_TYPES, isXeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'

// onetwo3d-ims-30tg: IMS reportingCategory + usedFor -> Xero ReportTaxType.

test('DOMESTIC files to OUTPUT on sales/both, INPUT on purchase', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'SALES' }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'BOTH' }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'PURCHASE' }), 'INPUT')
})

test('REVERSE_CHARGE always files to REVERSECHARGES regardless of usedFor', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'REVERSE_CHARGE', usedFor: 'SALES' }), 'REVERSECHARGES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'REVERSE_CHARGE', usedFor: 'PURCHASE' }), 'REVERSECHARGES')
})

test('EC_SALES splits by usedFor', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'EC_SALES', usedFor: 'SALES' }), 'ECOUTPUTSERVICES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'EC_SALES', usedFor: 'BOTH' }), 'ECOUTPUTSERVICES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'EC_SALES', usedFor: 'PURCHASE' }), 'ECACQUISITIONS')
})

test('zero-rated OSS rates outside EU/IOSS/VOEC are exempt (Xero rejects NONE at creation)', () => {
  // Channel Islands at 0% → EXEMPT (a valid exempt rate has a zero component).
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'SALES', name: 'CI VAT', rate: 0 }), 'EXEMPTOUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'PURCHASE', name: 'CI VAT', rate: 0 }), 'EXEMPTINPUT')
  // Missing rate is treated as zero-rated (defaults to exempt).
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'BOTH', name: 'CI VAT' }), 'EXEMPTOUTPUT')
})

test('non-zero OSS rates outside EU/IOSS/VOEC fall back to OUTPUT/INPUT (Xero forbids non-zero exempt)', () => {
  // Isle of Man / Monaco at 20% can't be exempt → safe default the operator overrides.
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'SALES', name: 'IM VAT', rate: 0.2 }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'BOTH', name: 'MC VAT', rate: 0.2 }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'PURCHASE', name: 'MC VAT', rate: 0.2 }), 'INPUT')
})

test('VOEC (Norway/NO) sales report via MOSS Sales, like the EU OSS rates', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'SALES', name: 'NO VAT' }), 'MOSSSALES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'BOTH', name: 'NO VAT' }), 'MOSSSALES')
  // VOEC is a sales scheme — a purchase-only NO rate falls back to the exempt default.
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'PURCHASE', name: 'NO VAT' }), 'EXEMPTINPUT')
})

test('unset category defaults to OUTPUT/INPUT by usedFor', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES' }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'BOTH' }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'PURCHASE' }), 'INPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: undefined, usedFor: undefined }), 'OUTPUT')
})

test('category and usedFor are normalized (case, separators, whitespace)', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'reverse-charge', usedFor: 'sales' }), 'REVERSECHARGES')
  assert.equal(xeroReportTaxType({ reportingCategory: ' ec_sales ', usedFor: ' purchase ' }), 'ECACQUISITIONS')
  assert.equal(xeroReportTaxType({ reportingCategory: 'Domestic', usedFor: 'Purchase' }), 'INPUT')
})

// onetwo3d-ims-tdzp: EU-ISO-prefixed sales rates default to MOSS Sales.

test('EU-ISO-prefixed sales rate defaults to MOSSSALES, overriding the category default', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES', name: 'DE Standard' }), 'MOSSSALES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'BOTH', name: 'FR 20%' }), 'MOSSSALES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'SALES', name: 'NL Reduced' }), 'MOSSSALES')
  assert.equal(xeroReportTaxType({ reportingCategory: 'EC_SALES', usedFor: 'SALES', name: 'IT 22%' }), 'MOSSSALES')
})

test('EU-ISO match only on a leading 2-letter token, not a longer word', () => {
  // "Deutschland" starts with DE but is one word → not an ISO prefix.
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'SALES', name: 'Deutschland VAT' }), 'OUTPUT')
  // Hyphen / punctuation boundaries still match.
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES', name: 'ES-IVA' }), 'MOSSSALES')
  // Greece variant EL is recognised.
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES', name: 'EL 24%' }), 'MOSSSALES')
})

test('non-EU ISO prefixes (GB, US) do not trigger MOSS', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'SALES', name: 'GB Standard' }), 'OUTPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES', name: 'US Sales Tax' }), 'OUTPUT')
})

test('explicit REVERSE_CHARGE wins over the EU MOSS default', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'REVERSE_CHARGE', usedFor: 'SALES', name: 'DE Reverse Charge' }), 'REVERSECHARGES')
})

test('MOSS is sales-only — a purchase-only EU rate keeps its category default', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'DOMESTIC', usedFor: 'PURCHASE', name: 'DE Standard' }), 'INPUT')
  assert.equal(xeroReportTaxType({ reportingCategory: 'EC_SALES', usedFor: 'PURCHASE', name: 'FR 20%' }), 'ECACQUISITIONS')
})

// onetwo3d-ims-tdzp: report-type override validation (guards the user-editable
// confirmation dialog before anything is sent to Xero).

test('isXeroReportTaxType accepts every advertised option and every computed default', () => {
  for (const opt of XERO_REPORT_TAX_TYPES) assert.equal(isXeroReportTaxType(opt), true)
  assert.equal(isXeroReportTaxType('MOSSSALES'), true)
})

test('isXeroReportTaxType rejects unknown / empty / wrong-case values', () => {
  assert.equal(isXeroReportTaxType('BOGUS'), false)
  assert.equal(isXeroReportTaxType('output'), false)
  assert.equal(isXeroReportTaxType(''), false)
  assert.equal(isXeroReportTaxType(null), false)
  assert.equal(isXeroReportTaxType(undefined), false)
})

test('NONE is not an offered/accepted report type (Xero rejects it at creation)', () => {
  assert.equal(XERO_REPORT_TAX_TYPES.includes('NONE' as never), false)
  assert.equal(isXeroReportTaxType('NONE'), false)
})
