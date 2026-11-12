import assert from 'node:assert/strict'
import test from 'node:test'

import { EU_VAT_REFUND_HOLD_DEFAULT_THRESHOLD, parseCountSetting, parseGiftCardCutIn, parseRegimeMode, refundHoldThreshold } from '@/lib/domain/accounting/eu-vat-settings'
import { XERO_SETTING_KEYS } from '@/lib/connectors/xero/settings'
import { XERO_ACCOUNT_ROLE_KEYS } from '@/lib/connectors/xero/account-mapping-rebind'
import { ACCOUNT_FIELDS, isFieldAvailableForConnector } from '@/app/(dashboard)/sync/accounting-settings-fields'
import { loadEuVatSeed } from '@/lib/tax/eu-vat-seed'

test('the refund hold threshold defaults to 10, takes a stored count, and is null (hold, do not guess) for anything else', () => {
  assert.equal(EU_VAT_REFUND_HOLD_DEFAULT_THRESHOLD, 10)
  assert.equal(refundHoldThreshold(undefined), 10)
  assert.equal(refundHoldThreshold(' '), 10)
  assert.equal(refundHoldThreshold('25'), 25)
  assert.equal(refundHoldThreshold('0'), 0)
  for (const bad of ['-1', '1.5', 'ten', '1e3', '99999999999']) assert.equal(refundHoldThreshold(bad), null, bad)
  assert.deepEqual(parseCountSetting('7'), { state: 'ok', value: 7 })
  assert.deepEqual(parseCountSetting('x'), { state: 'invalid', raw: 'x' })
})

test('the three EU account roles are Xero account settings, owned by the organisation like the others, and offered on the form for Xero only', () => {
  for (const key of ['xero_eu_vat_ioss_account', 'xero_eu_vat_ddp_account', 'xero_eu_fee_account']) {
    assert.ok(XERO_SETTING_KEYS.includes(key), key)
    assert.ok(XERO_ACCOUNT_ROLE_KEYS.includes(key), `${key} is cleared and re-confirmed with the other account roles`)
    const field = ACCOUNT_FIELDS.find((f) => `xero_${f.suffix}` === key)
    assert.ok(field, `${key} is on the form`)
    assert.equal(isFieldAvailableForConnector(field, 'xero'), true)
  }
})

test('the declaration names the account settings and the hold settings the code reads', () => {
  const seed = loadEuVatSeed()
  for (const a of seed.accounts) if (a.settingKey !== null) assert.ok(XERO_SETTING_KEYS.includes(a.settingKey), a.settingKey)
  assert.equal(seed.refundHold.defaultThreshold, EU_VAT_REFUND_HOLD_DEFAULT_THRESHOLD)
  assert.equal(seed.accounts.find((a) => a.role === 'iossVatCollected')!.code, '821')
  assert.equal(seed.accounts.find((a) => a.role === 'rounding')!.code, '860', 'rounding posts to 860 (ruling Q7)')
})

test('the regime mode defaults to adopting the plugin, takes either named mode, and is null (refuse, do not guess) for anything else', () => {
  assert.equal(parseRegimeMode(undefined), 'adopt_plugin')
  assert.equal(parseRegimeMode(null), 'adopt_plugin')
  assert.equal(parseRegimeMode('  '), 'adopt_plugin')
  assert.equal(parseRegimeMode('adopt_plugin'), 'adopt_plugin')
  assert.equal(parseRegimeMode(' decide '), 'decide')
  for (const bad of ['Decide', 'on', 'true', 'adopt', 'decide;']) assert.equal(parseRegimeMode(bad), null, bad)
})

test('the gift-card flag cut-in is unset by default, takes a date (start of day UTC) or a zoned instant, and is invalid (refuse, do not guess) for anything else', () => {
  assert.deepEqual(parseGiftCardCutIn(undefined), { state: 'unset' })
  assert.deepEqual(parseGiftCardCutIn(null), { state: 'unset' })
  for (const blank of ['', ' ', '\t\n']) assert.equal(parseGiftCardCutIn(blank).state, 'invalid', `blank ${JSON.stringify(blank)} is a saved-wrongly value, not unset`)
  const day = parseGiftCardCutIn('2026-12-01')
  assert.ok(day.state === 'ok' && day.at.toISOString() === '2026-12-01T00:00:00.000Z')
  const inst = parseGiftCardCutIn('2026-12-01T10:30:00+01:00')
  assert.ok(inst.state === 'ok' && inst.at.toISOString() === '2026-12-01T09:30:00.000Z')
  for (const bad of ['01/12/2026', '2026-13-01', '2026-02-31', '2026-02-31T10:00:00Z', '2026-04-31T10:00:00+01:00', '2026-12-01T24:00:00Z', '2026-12-01T10:60:00Z', '2026-12-01T10:00:00+25:00', 'soon', '2026-12-01T10:00:00', '1764547200']) assert.equal(parseGiftCardCutIn(bad).state, 'invalid', bad)
})
