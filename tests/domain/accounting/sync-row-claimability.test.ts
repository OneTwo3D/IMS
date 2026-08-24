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
  assert.deepEqual(ACCOUNTING_SYNC_ENABLED_SETTING_KEYS, {
    xero: 'xero_sync_enabled',
    quickbooks: 'quickbooks_sync_enabled',
  })
  assert.equal(accountingSyncEnabledSettingKey('xero'), 'xero_sync_enabled')
  assert.equal(accountingSyncEnabledSettingKey('quickbooks'), 'quickbooks_sync_enabled')
})

test('an unrecognised connector is never reported quiesced — the conservative answer, not the convenient one', () => {
  // A connector nobody has walked has claim paths nobody has walked either. Answering "quiesced"
  // would hand it the adoption remedy on no evidence at all.
  assert.equal(accountingSyncEnabledSettingKey('shipstation'), null)
  assert.equal(isAccountingConnectorQuiesced('shipstation', null), false)
  assert.equal(isAccountingConnectorQuiesced('shipstation', 'false'), false)
  assert.equal(
    isStrandedRowUnclaimable({ connector: 'shipstation', activeConnector: 'xero', syncEnabledValue: null }),
    false,
  )
})

test('the toggle is read exactly as the gates read it: only the string "true" is on', () => {
  // `triggerQuickBooksSync` does `enabled?.value !== 'true'`. A missing row, an empty string and
  // 'TRUE' are all OFF there, so they must all be OFF here.
  assert.equal(isAccountingConnectorQuiesced('quickbooks', 'true'), false)
  for (const value of [null, undefined, '', 'false', 'TRUE', 'True', '1', 'yes']) {
    assert.equal(
      isAccountingConnectorQuiesced('quickbooks', value),
      true,
      `${JSON.stringify(value)} is not 'true', so no claim path is open`,
    )
  }
})

test('BOTH halves are required, and each one alone is insufficient', () => {
  const row = { connector: 'quickbooks' as const }

  // The state round 5 found. Xero enabled makes QuickBooks non-active and therefore "stranded";
  // quickbooks_sync_enabled left on means the manual Sync button still runs the QuickBooks
  // processor, whose stale-claim sweep reclaims a PROCESSING row. Adopting here is a settlement the
  // very next press overwrites.
  assert.equal(
    isStrandedRowUnclaimable({ ...row, activeConnector: 'xero', syncEnabledValue: 'true' }),
    false,
    'off the active connector is NOT on its own proof that nothing can claim the row',
  )

  // The other half alone: the toggle is off, but QuickBooks is still the active connector, so the
  // row is not stranded at all and has the ordinary route (retry it, the processor stamps an
  // attempt). Adoption is deliberately not offered there.
  assert.equal(
    isStrandedRowUnclaimable({ ...row, activeConnector: 'quickbooks', syncEnabledValue: 'false' }),
    false,
    'a row on the active connector is not adopted even with its toggle off',
  )

  // Both.
  assert.equal(isStrandedRowUnclaimable({ ...row, activeConnector: 'xero', syncEnabledValue: 'false' }), true)
  // And with no accounting plugin enabled at all, every unresolved row is stranded.
  assert.equal(isStrandedRowUnclaimable({ ...row, activeConnector: null, syncEnabledValue: null }), true)
})

test('the refusal names the toggle and the button, because "it is claimable" is not actionable', () => {
  const reason = describeStillClaimableStrandedRow('quickbooks')
  assert.match(reason, /quickbooks_sync_enabled/, 'the key an operator has to change')
  assert.match(reason, /manual\s+Sync button/, 'and what would otherwise reclaim the row')
  assert.match(reason, /whichever connector is active/, 'the fact that made round 4 wrong')

  // An unrecognised connector still gets a reason rather than an omitted control with no
  // explanation — it just cannot promise a lever it does not know about.
  const unknown = describeStillClaimableStrandedRow('shipstation')
  assert.ok(unknown.length > 0)
  assert.doesNotMatch(unknown, /_sync_enabled/)
})

test('only the toggles a page actually needs are collected, and duplicates collapse', () => {
  assert.deepEqual(accountingSyncEnabledSettingKeysFor([]), [])
  assert.deepEqual(accountingSyncEnabledSettingKeysFor(['quickbooks', 'quickbooks']), ['quickbooks_sync_enabled'])
  assert.deepEqual(
    accountingSyncEnabledSettingKeysFor(['quickbooks', 'xero', 'shipstation']).sort(),
    ['quickbooks_sync_enabled', 'xero_sync_enabled'],
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
test('both manual Sync actions gate on the toggle ALONE — the premise, read off the actions', async () => {
  const read = async (rel: string) => await readFile(path.join(process.cwd(), rel), 'utf8')

  for (const [file, fn, key] of [
    ['app/actions/quickbooks-sync.ts', 'export async function triggerQuickBooksSync', 'quickbooks_sync_enabled'],
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
