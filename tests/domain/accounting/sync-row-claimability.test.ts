import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  ACCOUNTING_SYNC_ENABLED_SETTING_KEYS,
  accountingSyncEnabledSettingKey,
  accountingSyncEnabledSettingKeysFor,
  describeStillClaimableStrandedRow,
  isAccountingConnectorQuiesced,
  isStrandedRowUnclaimable,
} from '@/lib/domain/accounting/sync-row-claimability'
import { ACCOUNTING_CONNECTORS, isRegisteredAccountingConnector } from '@/lib/connectors/accounting-registry'

/**
 * o3d-batch-ret ROUND 5 (Codex HIGH #1) — THE ADOPTION PRECONDITION, PINNED.
 *
 * Adoption settles a row that carries no attempt revision by asserting that the abandoned attempt in
 * front of the operator is the ONLY attempt the row can ever have had. Rounds 3 and 4 derived that
 * from the active connector alone, and it does not follow: the active connector comes from the
 * PLUGIN flags, while both manual Sync actions gate on `<connector>_sync_enabled` and never resolve
 * the active connector at all.
 *
 * The two halves are asserted separately below, so a change that drops either one fails here rather
 * than in an operator's hands.
 */

test('the toggle each connector actually gates on is the one this module names', () => {
  // o3d-remove-parked-connectors round 2 (Codex MEDIUM): `quickbooks_sync_enabled` WAS here, and its
  // presence was the defect — a key for a connector whose gates no longer exist reads a surviving
  // `settings` row as proof of a claim path. The map is now total over the REGISTERED roster and
  // holds nothing else.
  assert.deepEqual(ACCOUNTING_SYNC_ENABLED_SETTING_KEYS, { xero: 'xero_sync_enabled' })
  assert.equal(accountingSyncEnabledSettingKey('xero'), 'xero_sync_enabled')
  assert.equal(accountingSyncEnabledSettingKey('quickbooks'), null, 'archived: this build has no gate to name')
})

test('a connector this build does not service is QUIESCED — nothing can claim what nothing implements', () => {
  // THIS TEST WAS THE OPPOSITE WAY ROUND until round 2, and the old wording ("a connector nobody has
  // walked has claim paths nobody has walked either") is what made the defect look principled. It is
  // not conservative, it is wrong in the UNSAFE direction: "we cannot show it is quiet" was used to
  // refuse a settlement, so the fail-closed answer left a financial row with no exit at all while the
  // fail-open answer costs nothing — no processor selects rows for an unregistered connector, because
  // every candidate and claim query in the Xero processor is scoped `connector: XERO_CONNECTOR`.
  assert.equal(accountingSyncEnabledSettingKey('shipstation'), null)
  assert.equal(isAccountingConnectorQuiesced('shipstation', null), true)
  assert.equal(isAccountingConnectorQuiesced('shipstation', 'false'), true)
  assert.equal(isAccountingConnectorQuiesced('shipstation', 'true'), true, 'a stored toggle is not a claim path')
  assert.equal(
    isStrandedRowUnclaimable({ connector: 'shipstation', activeConnector: 'xero', syncEnabledValue: null }),
    true,
  )
})

test('the toggle is read exactly as the gates read it: only the string "true" is on', () => {
  // `triggerXeroSync` does `enabled?.value !== 'true'`. A missing row, an empty string and 'TRUE' are
  // all OFF there, so they must all be OFF here. Asked of a LIVE connector, because that is the only
  // kind whose toggle is consulted at all now.
  assert.equal(isAccountingConnectorQuiesced('xero', 'true'), false)
  for (const value of [null, undefined, '', 'false', 'TRUE', 'True', '1', 'yes']) {
    assert.equal(
      isAccountingConnectorQuiesced('xero', value),
      true,
      `${JSON.stringify(value)} is not 'true', so no claim path is open`,
    )
  }
})

test('BOTH halves are required, and each one alone is insufficient', () => {
  const row = { connector: 'xero' as const }

  // The state round 5 found, on the connector it is still true of. The Xero PLUGIN being off makes
  // this row non-active and therefore "stranded"; `xero_sync_enabled` left on means the manual Sync
  // button still runs the Xero processor, whose stale-claim sweep reclaims a PROCESSING row. Adopting
  // here is a settlement the very next press overwrites.
  assert.equal(
    isStrandedRowUnclaimable({ ...row, activeConnector: null, syncEnabledValue: 'true' }),
    false,
    'off the active connector is NOT on its own proof that nothing can claim the row',
  )

  // The other half alone: the toggle is off, but Xero is still the active connector, so the row is
  // not stranded at all and has the ordinary route (retry it, the processor stamps an attempt).
  // Adoption is deliberately not offered there.
  assert.equal(
    isStrandedRowUnclaimable({ ...row, activeConnector: 'xero', syncEnabledValue: 'false' }),
    false,
    'a row on the active connector is not adopted even with its toggle off',
  )

  // Both.
  assert.equal(isStrandedRowUnclaimable({ ...row, activeConnector: null, syncEnabledValue: 'false' }), true)
  assert.equal(isStrandedRowUnclaimable({ ...row, activeConnector: null, syncEnabledValue: null }), true)
})

test('the refusal names the toggle and the button, because "it is claimable" is not actionable', () => {
  const reason = describeStillClaimableStrandedRow('xero')
  assert.match(reason, /xero_sync_enabled/, 'the key an operator has to change')
  assert.match(reason, /manual\s+Sync button/, 'and what would otherwise reclaim the row')
  assert.match(reason, /whichever connector is active/, 'the fact that made round 4 wrong')

  // A connector this build does not service still gets a reason rather than an omitted control with
  // no explanation — it just cannot promise a lever that is not there. (Unreachable from either
  // caller now: such a connector is quiesced, so the control is offered instead of refused.)
  const unknown = describeStillClaimableStrandedRow('shipstation')
  assert.ok(unknown.length > 0)
  assert.doesNotMatch(unknown, /_sync_enabled/)
})

test('only the toggles a page actually needs are collected, and duplicates collapse', () => {
  assert.deepEqual(accountingSyncEnabledSettingKeysFor([]), [])
  assert.deepEqual(accountingSyncEnabledSettingKeysFor(['xero', 'xero']), ['xero_sync_enabled'])
  assert.deepEqual(
    accountingSyncEnabledSettingKeysFor(['quickbooks', 'xero', 'shipstation']).sort(),
    ['xero_sync_enabled'],
    'an archived or unknown connector needs no toggle read — there is no gate behind it',
  )
})

/**
 * The premise the whole module rests on, checked against the three files that implement the claim
 * paths rather than against a comment describing them.
 *
 * This one IS a source assertion, and deliberately: the claim is "these gates read this key and do
 * NOT resolve the active connector", which is a fact about code that no unit test of a pure function
 * can observe. It fails if either action gains an active-connector gate (in which case half of this
 * module becomes unnecessary) or loses the toggle gate (in which case the toggle stops being
 * sufficient and adoption must be re-derived).
 */
test('the manual Sync action gates on the toggle ALONE — the premise, read off the action', async () => {
  const read = async (rel: string) => await readFile(path.join(process.cwd(), rel), 'utf8')

  // o3d-remove-parked-connectors: the archived QuickBooks file was the second entry here, so this rule was checked against TWO independently-written implementations. One now.
  for (const [file, fn, key] of [
    ['app/actions/xero-sync.ts', 'export async function triggerXeroSync', 'xero_sync_enabled'],
  ] as const) {
    const src = await read(file)
    const start = src.indexOf(fn)
    assert.ok(start > 0, `${fn} must be found, or this test asserts nothing`)
    // The body up to the processor call — everything the action checks before it can claim a row.
    const body = src.slice(start, src.indexOf('processPending', start))
    assert.ok(body.length > 0, `${fn} must reach its processor call, or this test asserts nothing`)
    assert.ok(body.includes(key), `${fn} must gate on ${key}`)
    assert.doesNotMatch(
      body,
      /isIntegrationPluginEnabled|resolveActiveAccountingConnector|activeConnector/,
      `${fn} does NOT resolve the active connector — that is why being off it proves nothing`,
    )
  }
})

// ---------------------------------------------------------------------------
// o3d-remove-parked-connectors ROUND 2 (Codex MEDIUM) — AN ARCHIVED CONNECTOR HAS NO CLAIM PATH AT
// ALL, SO ITS LEFT-BEHIND TOGGLE IS NOT EVIDENCE OF ONE.
//
// The toggle was only ever a PROXY for "is there a deployed worker that can still claim this row".
// For a connector this build still services the proxy is right. For an ARCHIVED one it is wrong in
// the UNSAFE direction: it reports the row claimable when nothing in the deployment can claim it,
// and the operator is told to turn off a control the Sync page no longer renders.
// ---------------------------------------------------------------------------

test('[archived] a stranded revision-0 row on an ARCHIVED connector is settleable even with its stored toggle ON', () => {
  assert.equal(
    isRegisteredAccountingConnector('quickbooks'),
    false,
    'precondition: this build archives QuickBooks — if it is registered again this test asserts nothing',
  )
  assert.equal(isAccountingConnectorQuiesced('quickbooks', 'true'), true)
  assert.equal(
    isStrandedRowUnclaimable({ connector: 'quickbooks', activeConnector: 'xero', syncEnabledValue: 'true' }),
    true,
    'no processor, no cron branch and no Sync action exist for it, so the row can never be claimed again',
  )
})

test('[archived] and a LIVE connector with its sync enabled is STILL refused — the fix is not "always settleable"', () => {
  assert.equal(isRegisteredAccountingConnector('xero'), true)
  assert.equal(isAccountingConnectorQuiesced('xero', 'true'), false)
  // REACHABLE, and it is the mirror of the finding: the Xero PLUGIN off (so no active connector at
  // all) while `xero_sync_enabled` is still 'true'. `triggerXeroSync` gates on that toggle ALONE and
  // never reads the plugin flag, so the Xero processor can still claim this row.
  assert.equal(
    isStrandedRowUnclaimable({ connector: 'xero', activeConnector: null, syncEnabledValue: 'true' }),
    false,
    'a live connector still requires the operator to quiesce it',
  )
  // ONE variable changed.
  assert.equal(
    isStrandedRowUnclaimable({ connector: 'xero', activeConnector: null, syncEnabledValue: 'false' }),
    true,
  )
})

test('[archived] the refusal never names a control this build does not render', () => {
  for (const connector of ['quickbooks', 'shopify', 'shiphero', 'shipstation']) {
    assert.equal(isRegisteredAccountingConnector(connector), false, `${connector} must be unregistered here`)
    assert.doesNotMatch(
      describeStillClaimableStrandedRow(connector),
      /_sync_enabled|Sync settings/,
      `${connector} has no Sync-settings control, so no message may send an operator to one`,
    )
  }
  assert.match(describeStillClaimableStrandedRow('xero'), /xero_sync_enabled/, 'a live connector still gets its lever')
})

test('[archived] the toggle map is exactly the REGISTERED roster — no key for a connector nothing services', () => {
  assert.ok(ACCOUNTING_CONNECTORS.length >= 1, 'the registry must not be empty, or this loop asserts nothing')
  let checked = 0
  for (const connector of ACCOUNTING_CONNECTORS) {
    assert.equal(
      typeof accountingSyncEnabledSettingKey(connector.id),
      'string',
      `${connector.id} is serviced by this build, so the toggle its claim paths gate on must be named`,
    )
    checked += 1
  }
  console.log(`# registered accounting connectors checked: ${checked}`)
  assert.equal(checked, ACCOUNTING_CONNECTORS.length)
  assert.deepEqual(
    Object.keys(ACCOUNTING_SYNC_ENABLED_SETTING_KEYS).sort(),
    ACCOUNTING_CONNECTORS.map((connector) => connector.id as string).sort(),
  )
})
