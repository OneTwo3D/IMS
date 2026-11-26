import assert from 'node:assert/strict'
import test from 'node:test'
import type { XeroSettings } from '@/lib/connectors/xero/settings'
import { REQUIRED_ACCOUNTS, REPORT_ONLY_ACCOUNTS, xeroMissingAccountMappings } from '@/lib/connectors/xero/readiness-accounts'

/**
 * o3d-n2ci4 (#1135 review MED-3): which account mappings block "Xero sync can be enabled", and which are only reported.
 *
 * IMS posts no FX journal to Xero any more, so the AR / AP control accounts and the Realised FX account are read only by the IMS FX
 * gain/loss report, and the Unrealised FX account by nothing. A fresh install must be able to enable sync without mapping any of them.
 * [mutation: put any of the four back on REQUIRED_ACCOUNTS; drop REPORT_ONLY_ACCOUNTS from the report; list the unrealised account]
 */

function mappedExcept(...unmapped: Array<keyof XeroSettings>): XeroSettings {
  const settings: Record<string, string> = { xero_unrealised_fx_gain_loss_account: '100' }
  for (const field of [...REQUIRED_ACCOUNTS, ...REPORT_ONLY_ACCOUNTS]) settings[field.key] = '100'
  for (const key of unmapped) settings[key] = ''
  return settings as unknown as XeroSettings
}

test('no FX or control account blocks readiness: with all four unmapped nothing is missing', () => {
  const out = xeroMissingAccountMappings(mappedExcept(
    'xero_accounts_receivable_account', 'xero_accounts_payable_account', 'xero_realised_fx_gain_loss_account', 'xero_unrealised_fx_gain_loss_account',
  ))
  assert.deepEqual(out.missingAccounts, [])
  assert.deepEqual(out.reportOnlyMissingAccounts.map((a) => a.key), [
    'xero_accounts_receivable_account', 'xero_accounts_payable_account', 'xero_realised_fx_gain_loss_account',
  ], 'AR, AP and Realised FX are reported; the Unrealised FX account is not listed at all')
})

test('a posting account still blocks readiness (control: the split did not empty the required list)', () => {
  const out = xeroMissingAccountMappings(mappedExcept('xero_cogs_account'))
  assert.deepEqual(out.missingAccounts, [{ key: 'xero_cogs_account', label: 'Cost of Goods Sold' }])
  assert.deepEqual(out.reportOnlyMissingAccounts, [])
})

test('neither list names the unrealised FX account, and the two lists do not overlap', () => {
  const required = REQUIRED_ACCOUNTS.map((a) => a.key)
  const reported = REPORT_ONLY_ACCOUNTS.map((a) => a.key)
  assert.ok(!required.includes('xero_unrealised_fx_gain_loss_account'))
  assert.ok(!reported.includes('xero_unrealised_fx_gain_loss_account'))
  for (const key of ['xero_accounts_receivable_account', 'xero_accounts_payable_account', 'xero_realised_fx_gain_loss_account'] as const) {
    assert.ok(!required.includes(key), `${key} must not block readiness`)
  }
  assert.equal(required.filter((k) => reported.includes(k)).length, 0)
})

/**
 * #1140 LOW-1 / purchase FX step-2 LOW-14: while `purchase_event_fx_rates_enabled` is ON the Realised FX and Purchase Price Variance accounts are REQUIRED
 * (the receipt valuation refuses while either is blank), and Realised FX is then not also listed as report-only. Off: exactly as before.
 * [mutation: ignore the option; list Realised FX twice; leave PPV out]
 */
test('purchase FX switch ON: Realised FX and Purchase Price Variance block readiness when unmapped, and Realised FX is not also reported', () => {
  const unmapped = mappedExcept('xero_realised_fx_gain_loss_account', 'xero_purchase_price_variance_account', 'xero_accounts_payable_account')
  const on = xeroMissingAccountMappings(unmapped, { purchaseEventFxEnabled: true })
  assert.deepEqual(on.missingAccounts, [
    { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
    { key: 'xero_purchase_price_variance_account', label: 'Purchase Price Variance' },
  ])
  assert.deepEqual(on.reportOnlyMissingAccounts.map((a) => a.key), ['xero_accounts_payable_account'])
  const off = xeroMissingAccountMappings(unmapped, { purchaseEventFxEnabled: false })
  assert.deepEqual(off.missingAccounts, [], 'off: neither blocks')
  assert.deepEqual(xeroMissingAccountMappings(unmapped), off, 'no option = off')
  const everything = { ...mappedExcept(), xero_purchase_price_variance_account: '100' } as unknown as XeroSettings
  assert.deepEqual(xeroMissingAccountMappings(everything, { purchaseEventFxEnabled: true }).missingAccounts, [])
})
