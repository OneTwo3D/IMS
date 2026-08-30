import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER } from '@/lib/integration-plugin-keys'
import { ACCOUNTING_BINDING_SETTING_KEYS } from '@/lib/connectors/accounting-binding-lock-order'
import {
  RESERVED_SETTING_KEYS,
  RESERVED_SETTING_KEY_PREFIXES,
  reservedSettingKeyRefusal,
} from '@/lib/domain/settings/reserved-setting-keys'
import { settingKeyWriteRefusal } from '@/lib/domain/settings/writable-setting-keys'

// ---------------------------------------------------------------------------
// THIS MODULE NO LONGER DECIDES WHETHER A WRITE IS ALLOWED (Codex r20 HIGH).
//
// r19 made it the generic writers' guard — a DENYLIST of the system-managed families. r20 showed the
// shape was wrong: a denylist over a growing key space is only as complete as the last search for
// keys, and this one had already missed `MACHINE_MANAGED_SYNC_KEYS`. The guard is now the ALLOWLIST
// in `writable-setting-keys.ts`, and the behavioural proofs live with it, in
// `tests/settings/writable-setting-keys.test.ts` — including the proof that the four families r20
// names are refused through BOTH writers.
//
// What survives here is the MESSAGE TABLE: which writer owns a key we have already named, so a
// refusal points somewhere instead of ending at "no". These tests hold that table to what it claims:
//   1. every family maps to a message, driven from the OWNING constants — which is also what checks
//      the literals this module carries against the modules that own them
//   2. the run-time-built families' prefixes are prefixes something actually builds
//   3. the table is subordinate: it never widens the gate, and `null` here never means writable
// ---------------------------------------------------------------------------

const REPO = process.cwd()

test('every family named in the module maps to a refusal message', async () => {
  const { MINTSOFT_AUTH_LOCK_SETTING_KEY } = await import('@/lib/connectors/mintsoft/api/auth-lock')
  const { MAINTENANCE_ENABLED_KEY, MAINTENANCE_REASON_KEY, MAINTENANCE_HOLD_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY } =
    await import('@/lib/maintenance-mode')

  const families: Array<[string, readonly string[]]> = [
    ['integration plugin flags', INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER],
    ['accounting binding rows', ACCOUNTING_BINDING_SETTING_KEYS],
    ['maintenance fence', [MAINTENANCE_ENABLED_KEY, MAINTENANCE_REASON_KEY, MAINTENANCE_HOLD_KEY, WMS_BOOKED_IN_RECHECK_DUE_KEY]],
    ['leases', [MINTSOFT_AUTH_LOCK_SETTING_KEY]],
  ]

  let checked = 0
  for (const [family, keys] of families) {
    assert.ok(keys.length > 0, `${family}: an empty family would assert nothing`)
    for (const key of keys) {
      const message = reservedSettingKeyRefusal(key)
      assert.ok(message, `${family}: ${key} must have a message`)
      assert.ok(message!.includes(key), `${family}: ${key}'s message must name the key`)
      assert.ok(RESERVED_SETTING_KEYS.includes(key), `${family}: ${key} must be listed`)
      checked += 1
    }
  }
  // The families' own constants supply the keys, so a key added to a family is covered here without
  // this file changing — but only if the walk actually reached them.
  assert.equal(checked, RESERVED_SETTING_KEYS.length, 'every reserved key belongs to a named family')
  assert.ok(checked >= 12, `the walk reached ${checked} keys`)
})

test('the run-time-built families are prefixes something actually builds', () => {
  // A prefix that matched nothing would make the message fiction — it would name a family no writer
  // has, while the refusal itself (which the allowlist decides) stood on other grounds entirely.
  const builders: Record<string, string> = {
    'wms_dispatch_unresolved_drift:': 'lib/domain/wms/dispatch-sweep.ts',
    'wms_dispatch_unresolved_streak:': 'lib/domain/wms/unresolved-drift.ts',
  }

  assert.deepEqual([...RESERVED_SETTING_KEY_PREFIXES].sort(), Object.keys(builders).sort())
  for (const [prefix, file] of Object.entries(builders)) {
    const source = readFileSync(join(REPO, file), 'utf8')
    assert.ok(source.includes(`\`${prefix}`), `${file} no longer builds keys under '${prefix}'`)
    assert.ok(reservedSettingKeyRefusal(`${prefix}anything`), `${prefix}* must map to its family's message`)
  }
  assert.equal(reservedSettingKeyRefusal('wms_dispatch_unresolved_drift'), null, 'the bare stem is not the family')
})

test('the message table is SUBORDINATE — it never widens the gate', () => {
  // The one property that keeps this from being a second, overlapping half-guard: a key this module
  // says nothing about is still refused, and a key it does name is refused for the allowlist's
  // reason with this module's sentence. So `null` here can never mean "writable".
  for (const key of ['some_key_this_table_has_never_heard_of', 'wc_initial_import_completed', 'public_app_url']) {
    assert.equal(reservedSettingKeyRefusal(key), null, `${key} is deliberately absent from the table`)
    assert.ok(settingKeyWriteRefusal(key), `${key} is refused anyway, by the allowlist`)
  }

  // And where the table DOES have an entry, that entry is the sentence the writer refuses with —
  // otherwise keeping it would buy nothing.
  const owned = RESERVED_SETTING_KEYS[0]
  assert.equal(settingKeyWriteRefusal(owned), reservedSettingKeyRefusal(owned))
})
