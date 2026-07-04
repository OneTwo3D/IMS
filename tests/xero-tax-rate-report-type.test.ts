import assert from 'node:assert/strict'
import test from 'node:test'

import { xeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'

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

test('OSS files to NONE (no UK VAT-return box)', () => {
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'SALES' }), 'NONE')
  assert.equal(xeroReportTaxType({ reportingCategory: 'OSS', usedFor: 'PURCHASE' }), 'NONE')
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
