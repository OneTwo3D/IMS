import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCOUNT_FIELDS,
  buildAccountingSettingsPayload,
  isFieldAvailableForConnector,
  settingKeyFor,
} from '@/app/(dashboard)/sync/accounting-settings-fields'

// iwrm: the accounting settings form is shared by Xero and QuickBooks. The save
// payload must use the active connector's key prefix; previously it hardcoded
// xero_* keys, so saveQuickBooksSettings' allowlist dropped every qbo_* mapping
// and NO QuickBooks account was UI-configurable.

test('QuickBooks payload uses quickbooks_ prefix and persists the rounding-difference account', () => {
  const state: Record<string, string> = {
    quickbooks_sales_account: '4000',
    quickbooks_cogs_account: '5000',
    quickbooks_rounding_difference_account: '6900',
    quickbooks_sync_enabled: 'true',
    // A stray xero_* value must never leak into a QuickBooks save.
    xero_sales_account: 'LEAK',
  }
  const payload = buildAccountingSettingsPayload('quickbooks', state)

  assert.equal(payload.quickbooks_sales_account, '4000')
  assert.equal(payload.quickbooks_cogs_account, '5000')
  // scjz.60b parity: the QuickBooks rounding-difference account is now saveable.
  assert.equal(payload.quickbooks_rounding_difference_account, '6900')
  assert.equal(payload.quickbooks_sync_enabled, 'true')

  // Every persisted key is quickbooks_-prefixed — no xero_* leakage.
  assert.ok(Object.keys(payload).every((k) => k.startsWith('quickbooks_')), 'all keys quickbooks_-prefixed')
  assert.equal('xero_sales_account' in payload, false)

  // inventory_revaluation is Xero-only — it must not appear in a QuickBooks payload.
  assert.equal('quickbooks_inventory_revaluation_account' in payload, false)
})

test('Xero payload uses xero_ prefix and includes both Xero-only account keys', () => {
  const state: Record<string, string> = {
    xero_sales_account: '200',
    xero_inventory_revaluation_account: '310',
    xero_rounding_difference_account: '860',
  }
  const payload = buildAccountingSettingsPayload('xero', state)

  assert.equal(payload.xero_sales_account, '200')
  assert.equal(payload.xero_inventory_revaluation_account, '310')
  assert.equal(payload.xero_rounding_difference_account, '860')
  assert.ok(Object.keys(payload).every((k) => k.startsWith('xero_')), 'all keys xero_-prefixed')
})

test('missing settings default to empty string (cleared mapping, not undefined)', () => {
  const payload = buildAccountingSettingsPayload('quickbooks', {})
  assert.equal(payload.quickbooks_sales_account, '')
  assert.equal(payload.quickbooks_sync_enabled, '')
  assert.ok(Object.values(payload).every((v) => typeof v === 'string'))
})

test('isFieldAvailableForConnector gates Xero-only fields', () => {
  const revaluation = ACCOUNT_FIELDS.find((f) => f.suffix === 'inventory_revaluation_account')!
  const sales = ACCOUNT_FIELDS.find((f) => f.suffix === 'sales_account')!
  assert.equal(isFieldAvailableForConnector(revaluation, 'xero'), true)
  assert.equal(isFieldAvailableForConnector(revaluation, 'quickbooks'), false)
  // A shared field is available on both connectors.
  assert.equal(isFieldAvailableForConnector(sales, 'xero'), true)
  assert.equal(isFieldAvailableForConnector(sales, 'quickbooks'), true)
})

test('settingKeyFor composes the connector prefix', () => {
  assert.equal(settingKeyFor('xero', 'sales_account'), 'xero_sales_account')
  assert.equal(settingKeyFor('quickbooks', 'sales_account'), 'quickbooks_sales_account')
})
