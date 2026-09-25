import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACCOUNTING_CONNECTOR_IDS,
  ACCOUNT_FIELDS,
  buildAccountingSettingsPayload,
  isFieldAvailableForConnector,
  settingKeyFor,
  validateAccountingAccountMapping,
} from '@/app/(dashboard)/sync/accounting-settings-fields'
import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'

// iwrm: the accounting settings form is connector-agnostic and the save payload must use the ACTIVE
// connector's key prefix; it previously hardcoded xero_* keys, so the other connector's allowlist
// dropped every one of its mappings and none of its accounts was UI-configurable.
//
// o3d-remove-parked-connectors — WHY THE SECOND-CONNECTOR CASES NOW USE AN UNREGISTERED ID.
//
// The defect this file exists for is a PREFIX defect: the payload builder must key off the connector
// it was given, not off whichever connector is active. With one registered connector, every
// `buildAccountingSettingsPayload('xero', …)` case passes equally well for a builder that ignores its
// argument and hardcodes `xero_` — which is the exact bug. So the prefix cases drive an id the union
// does not contain: what is asserted is that the ARGUMENT decides the prefix, which is the property,
// and it cannot be satisfied by a hardcode. The Xero-only field gating is asserted the same way.
const OTHER_CONNECTOR = 'other-ledger' as unknown as AccountingConnectorId

test('the payload prefix comes from the CONNECTOR ARGUMENT, not from a hardcoded xero_', () => {
  const state: Record<string, string> = {
    'other-ledger_sales_account': '4000',
    'other-ledger_cogs_account': '5000',
    'other-ledger_rounding_difference_account': '6900',
    'other-ledger_sync_enabled': 'true',
    // A stray xero_* value must never leak into another connector's save.
    xero_sales_account: 'LEAK',
  }
  const payload = buildAccountingSettingsPayload(OTHER_CONNECTOR, state)

  assert.equal(payload['other-ledger_sales_account'], '4000')
  assert.equal(payload['other-ledger_cogs_account'], '5000')
  assert.equal(payload['other-ledger_rounding_difference_account'], '6900')
  assert.equal(payload['other-ledger_sync_enabled'], 'true')

  // Every persisted key carries the argument's prefix — no xero_* leakage.
  assert.ok(Object.keys(payload).every((k) => k.startsWith('other-ledger_')), 'all keys take the argument prefix')
  assert.equal('xero_sales_account' in payload, false)

  // inventory_revaluation is Xero-only — it must not appear in another connector's payload.
  assert.equal('other-ledger_inventory_revaluation_account' in payload, false)
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
  const payload = buildAccountingSettingsPayload(OTHER_CONNECTOR, {})
  assert.equal(payload['other-ledger_sales_account'], '')
  assert.equal(payload['other-ledger_sync_enabled'], '')
  assert.ok(Object.values(payload).every((v) => typeof v === 'string'))
})

test('isFieldAvailableForConnector gates Xero-only fields', () => {
  const revaluation = ACCOUNT_FIELDS.find((f) => f.suffix === 'inventory_revaluation_account')!
  const sales = ACCOUNT_FIELDS.find((f) => f.suffix === 'sales_account')!
  assert.equal(isFieldAvailableForConnector(revaluation, 'xero'), true)
  assert.equal(isFieldAvailableForConnector(revaluation, OTHER_CONNECTOR), false,
    'a field restricted to xero is NOT offered to another connector — the restriction is real')
  // A shared field (no `connectors` restriction) is available on every connector.
  assert.equal(isFieldAvailableForConnector(sales, 'xero'), true)
  assert.equal(isFieldAvailableForConnector(sales, OTHER_CONNECTOR), true)
})

test('settingKeyFor composes the connector prefix', () => {
  assert.equal(settingKeyFor('xero', 'sales_account'), 'xero_sales_account')
  assert.equal(settingKeyFor(OTHER_CONNECTOR, 'sales_account'), 'other-ledger_sales_account')
})


/**
 * Stage ran with allocated_inventory_account == transit_account (both 632) and NOTHING
 * complained — not the save path, not a readiness view (o3d-f82). The harm only surfaces
 * later, as a transit reconciliation gap that reads like a data problem rather than the
 * settings mistake it is. These pin the guard that now refuses the collision at save time.
 */
test('accounting mapping rejects transit and allocated inventory sharing an account', () => {
  const errors = validateAccountingAccountMapping({
    xero_transit_account: '632',
    xero_allocated_inventory_account: '632',
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /632/)
  assert.match(errors[0].message, /Stock in Transit/i)
  assert.match(errors[0].message, /Allocated Inventory/i)
  assert.deepEqual(errors[0].keys, ['xero_transit_account', 'xero_allocated_inventory_account'])
})

test('accounting mapping accepts distinct transit and allocated inventory accounts', () => {
  assert.deepEqual(
    validateAccountingAccountMapping({
      xero_transit_account: '632',
      xero_allocated_inventory_account: '633',
    }),
    [],
  )
})

test('accounting mapping treats blank accounts as unset, not as a collision', () => {
  // Several of these are legitimately unconfigured; two blanks are not "the same account".
  assert.deepEqual(
    validateAccountingAccountMapping({
      xero_transit_account: '',
      xero_allocated_inventory_account: '',
    }),
    [],
  )
})

test('accounting mapping ignores surrounding whitespace when comparing accounts', () => {
  // ' 632' and '632' are the same account to Xero; a guard fooled by a stray space is
  // worse than none, because it reports success.
  const errors = validateAccountingAccountMapping({
    xero_transit_account: '632 ',
    xero_allocated_inventory_account: ' 632',
  })
  assert.equal(errors.length, 1, 'whitespace must not smuggle a collision past the guard')
})

test('accounting mapping validates EVERY REGISTERED connector\'s key prefix, and only those', () => {
  // REGRESSION (found by Codex review of PR #488): the first cut took the connector from
  // saveAccountingSettings' getActiveAccountingConnector(), which resolves the ACTIVE connector and
  // ignores the ?connector= param the client builds its payload from. A second connector's save was
  // therefore checked against xero_* keys, found nothing, and passed silently.
  //
  // o3d-remove-parked-connectors — WHAT THE FIX ACTUALLY DOES, now that it matters. The validator
  // loops `ACCOUNTING_CONNECTOR_IDS` and checks each one's prefix; it does NOT parse the payload for
  // arbitrary prefixes. While two connectors were registered, "it checks the other one too" and "it
  // checks every registered one" were the same assertion. They are not the same now, and the true one
  // is the second — so it is asserted by driving the REGISTRY rather than a literal, which is also
  // what makes it keep working when a connector is added.
  assert.ok(ACCOUNTING_CONNECTOR_IDS.length >= 1, 'the registry must not be empty, or this loop asserts nothing')
  let checked = 0
  for (const connectorId of ACCOUNTING_CONNECTOR_IDS) {
    const errors = validateAccountingAccountMapping({
      [settingKeyFor(connectorId, 'transit_account')]: '632',
      [settingKeyFor(connectorId, 'allocated_inventory_account')]: '632',
    })
    assert.equal(errors.length, 1, `${connectorId}: the collision must be caught under its own prefix`)
    checked += 1
  }
  assert.equal(checked, ACCOUNTING_CONNECTOR_IDS.length)

  // AND ONLY THOSE. A prefix no registered connector owns is not checked — correctly: a save is
  // always FOR a registered connector (the /sync route resolves `?connector=` through the registry and
  // falls back to the first registered id), so an unknown prefix in a payload is not a mapping this
  // installation can have. Asserted rather than assumed, because it is the boundary of the rule above.
  assert.deepEqual(
    validateAccountingAccountMapping({
      'other-ledger_transit_account': '632',
      'other-ledger_allocated_inventory_account': '632',
    }),
    [],
    'an unregistered prefix is outside the rule — the loop is over registered ids, not over the payload',
  )
})


test('accounting mapping does NOT block a save when the collision already exists and is untouched', () => {
  // REGRESSION (found by Codex review of PR #488): the guard refused the WHOLE save while
  // any collision existed. If settings already collided and the account cache was empty or
  // the connector disconnected — so the UI hides the account selectors entirely — an admin
  // could not even turn sync off, and had no way to repair the very fields being rejected.
  // The rule is "you may not INTRODUCE a collision", not "nothing works while one exists".
  const colliding = { xero_transit_account: '632', xero_allocated_inventory_account: '632' }
  assert.deepEqual(
    validateAccountingAccountMapping(colliding, colliding),
    [],
    'a pre-existing, unchanged collision must not block an unrelated save',
  )
})

test('accounting mapping still blocks a save that INTRODUCES a collision', () => {
  const before = { xero_transit_account: '632', xero_allocated_inventory_account: '633' }
  const after = { xero_transit_account: '632', xero_allocated_inventory_account: '632' }
  assert.equal(validateAccountingAccountMapping(after, before).length, 1)
})

test('accounting mapping blocks a save that CHANGES a collision to a different shared account', () => {
  // Still a collision, just a different one — moving 632/632 to 999/999 must not sneak past
  // the "unchanged" escape hatch.
  const before = { xero_transit_account: '632', xero_allocated_inventory_account: '632' }
  const after = { xero_transit_account: '999', xero_allocated_inventory_account: '999' }
  assert.equal(validateAccountingAccountMapping(after, before).length, 1)
})
