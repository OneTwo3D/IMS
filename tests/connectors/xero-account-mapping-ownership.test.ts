import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  XERO_ACCOUNT_MAPPING_KEYS,
  mappingOwnershipVerdict,
  syncReadinessVerdict,
  xeroAccountMappingResetMessage,
} from '../../lib/connectors/xero/account-mapping-rebind'

/**
 * o3d-6thk1 round 1: the pure rules. Readiness must not be `ready` while the mapping's ownership is in
 * doubt, whatever else is satisfied; the operator text must say what happened and nothing it cannot know.
 */

test('mappingOwnershipVerdict: the full truth table', () => {
  const cases: Array<[Parameters<typeof mappingOwnershipVerdict>[0], ReturnType<typeof mappingOwnershipVerdict>]> = [
    [{ boundTenantId: null, stampedTenantId: null, mappingPresent: true }, 'owned'],              // not connected: nothing to compare
    [{ boundTenantId: 'B', stampedTenantId: null, mappingPresent: false }, 'owned'],              // nothing mapped: nothing to own
    [{ boundTenantId: 'B', stampedTenantId: 'B', mappingPresent: true }, 'owned'],
    [{ boundTenantId: 'B', stampedTenantId: null, mappingPresent: true }, 'unconfirmed'],
    [{ boundTenantId: 'B', stampedTenantId: 'A', mappingPresent: true }, 'other-organisation'],
    [{ boundTenantId: 'B', stampedTenantId: 'A', mappingPresent: false }, 'owned'],
  ]
  for (const [input, expected] of cases) assert.equal(mappingOwnershipVerdict(input), expected, JSON.stringify(input))
  console.log(`# o3d-6thk1 ownership verdict cases: ${cases.length}`)
})

test('syncReadinessVerdict: ownership alone can hold readiness down, and only "owned" releases it', () => {
  const ok = { connected: true, missingAccounts: 0, missingTaxTypes: 0 }
  assert.equal(syncReadinessVerdict({ ...ok, ownership: 'owned' }), true, 'CONTROL: everything satisfied is ready')
  assert.equal(syncReadinessVerdict({ ...ok, ownership: 'unconfirmed' }), false)
  assert.equal(syncReadinessVerdict({ ...ok, ownership: 'other-organisation' }), false)
  assert.equal(syncReadinessVerdict({ ...ok, connected: false, ownership: 'owned' }), false)
  assert.equal(syncReadinessVerdict({ ...ok, missingAccounts: 1, ownership: 'owned' }), false)
  assert.equal(syncReadinessVerdict({ ...ok, missingTaxTypes: 1, ownership: 'owned' }), false)
})

test('getXeroSyncReadiness derives `ready` from syncReadinessVerdict, not from a second spelling', () => {
  const src = readFileSync(new URL('../../app/actions/xero-sync.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export async function getXeroSyncReadiness'))
  const ready = body.slice(body.indexOf('ready:'), body.indexOf('notConnected:'))
  console.log(`# o3d-6thk1 readiness expression: ${ready.trim().slice(0, 140)}`)
  assert.match(ready, /syncReadinessVerdict\(\{[^}]*ownership: ownership\.state/)
})

test('the mapping key list covers 15 roles, the payment map and the two reverse-charge types', () => {
  assert.equal(XERO_ACCOUNT_MAPPING_KEYS.length, 18)
  assert.ok(XERO_ACCOUNT_MAPPING_KEYS.includes('accounting_payment_account_map'))
  assert.ok(XERO_ACCOUNT_MAPPING_KEYS.includes('xero_rounding_difference_account'))
})

test('operator text: the UNCONFIRMED case never claims another organisation; the CLEARED case says what was cleared', () => {
  const prev = { tenantId: 'A', basis: 'stamp' as const }
  const unconfirmed = xeroAccountMappingResetMessage({ tenantName: 'Org B', outcome: { kind: 'unconfirmed', previous: { tenantId: null, basis: 'unknown' }, keptKeys: ['xero_sales_account'], chartRowsCleared: 4, syncWasEnabled: true } })
  assert.match(unconfirmed, /could not confirm which organisation this mapping was set up for: sync is OFF until you confirm/)
  assert.match(unconfirmed, /kept exactly as it was/)
  assert.doesNotMatch(unconfirmed, /not the organisation|different/i)
  assert.match(unconfirmed, /cached chart of accounts was cleared/, 'it says the chart choices are empty until Sync accounts')
  assert.match(unconfirmed, /kept exactly as it was/, 'and that the mapping itself was not touched')
  const cleared = xeroAccountMappingResetMessage({ tenantName: 'Org B', outcome: { kind: 'cleared', previous: prev, clearedKeys: ['a', 'b'], taxRatesCleared: 2, taxRateComponentsCleared: 1, chartRowsCleared: 9, syncWasEnabled: true } })
  assert.match(cleared, /not the organisation the account mapping was set up for \(A\)/)
  assert.match(cleared, /2 mapping settings and 3 tax-type mappings/)
  assert.match(cleared, /switched off/)
  assert.doesNotMatch(cleared, /nothing (was|is) (posted|debited|sent)/i, 'no claim about documents already queued or posted')
})
