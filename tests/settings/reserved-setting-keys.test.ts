import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { mock } from 'node:test'

import { INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER } from '@/lib/integration-plugin-keys'
import { ACCOUNTING_BINDING_SETTING_KEYS } from '@/lib/connectors/accounting-binding-lock-order'
import {
  RESERVED_SETTING_KEYS,
  RESERVED_SETTING_KEY_PREFIXES,
  reservedSettingKeyRefusal,
} from '@/lib/domain/settings/reserved-setting-keys'

// ---------------------------------------------------------------------------
// Codex r19 HIGH — the generic settings writer would write a SYSTEM-MANAGED key.
//
// `setSetting` and `setSettings` are exported server actions taking an arbitrary key, so each is its
// own addressable endpoint. Until r19 they refused exactly one family (the integration plugin flags)
// from a list written inline, which meant every other system-managed key — the accounting binding
// pins, the maintenance fence, the lock leases — was writable by any principal holding
// 'settings.company', the gate the ordinary retention screen needs.
//
// WHAT THESE TESTS PIN, and the route each takes:
//   1. setSettings refuses a reserved key and commits NOTHING     (setSettings → assertWritableSettingKeys)
//   2. setSetting refuses one on its OWN assertion, not by
//      delegating to setSettings                                  (setSetting → assertWritableSettingKeys)
//   3. an ordinary preference key still writes through both        (non-vacuity — the guard is not "refuse all")
//   4. every family named in the module IS refused, driven from
//      the owning constants rather than restated                   (reservedSettingKeyRefusal)
//   5. the literals the module carries equal the owning modules'
//      constants                                                   (checked duplication)
//   6. a run-time-BUILT key is refused by its family prefix        (reservedSettingKeyRefusal)
// ---------------------------------------------------------------------------

const REPO = process.cwd()

const state = {
  /** Every settings row written, in commit order. A refusal must leave this empty. */
  writes: [] as string[],
  /** Permissions demanded, in order. Used to tell WHICH writer refused — see test 2. */
  permissions: [] as string[],
  /** Transactions opened. A refusal must not open one. */
  transactions: 0,
}

function reset() {
  state.writes = []
  state.permissions = []
  state.transactions = 0
}

const txClient = {
  setting: {
    upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
      state.writes.push(`${where.key}=${create.value}`)
      return { key: where.key, value: create.value }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: txClient.setting,
      $transaction: async (arg: unknown) => {
        state.transactions += 1
        return typeof arg === 'function'
          ? (arg as (tx: typeof txClient) => Promise<unknown>)(txClient)
          : Promise.all(arg as unknown[])
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requirePermission: async (permission: string) => {
      state.permissions.push(permission)
      return { user: { id: 'u1', role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function actions() {
  return import('@/app/actions/settings')
}

/** A reserved key from each family, so no test depends on one family's membership. */
const SAMPLES = {
  plugin: INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER[0],
  binding: ACCOUNTING_BINDING_SETTING_KEYS[0],
  maintenance: 'system_maintenance_mode',
  lease: 'mintsoft_auth_lock',
}

test.beforeEach(reset)

test('setSettings REFUSES a reserved key and commits nothing', async () => {
  const { setSettings } = await actions()

  for (const key of Object.values(SAMPLES)) {
    reset()
    await assert.rejects(
      () => setSettings({ [key]: 'anything' }),
      (error: Error) => {
        assert.match(error.message, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        return true
      },
      `${key} must be refused by the generic writer`,
    )
    // The refusal is what matters; that it happens BEFORE the commit is what makes it a refusal
    // rather than a report. Both are asserted, because a check placed after the transaction would
    // still reject the action while having already written the row.
    assert.deepEqual(state.writes, [], `${key}: nothing may be committed`)
    assert.equal(state.transactions, 0, `${key}: no transaction may even open`)
  }
})

test('a reserved key mixed into an otherwise ordinary save takes the WHOLE save down', async () => {
  // The group writer is atomic, so a partial commit is the failure mode that matters: refusing the
  // reserved key while writing its neighbours would leave the screen's other values stored and the
  // caller told the save failed.
  const { setSettings } = await actions()

  await assert.rejects(() =>
    setSettings({
      retention_webhook_events_months: '6',
      [SAMPLES.binding]: 'tenant-i-chose',
      financial_year_start: '04-01',
    }))

  assert.deepEqual(state.writes, [], 'not one key of the group is written')
  assert.equal(state.transactions, 0)
})

test('setSetting refuses on its OWN assertion, before it delegates', async () => {
  // WHY THIS IS OBSERVABLE. `setSettings` awaits requirePermission('settings.company') BEFORE it
  // checks the key. So a refusal that came from the delegation would have recorded a permission
  // check first; a refusal from setSetting's own line records none. That is the difference between
  // "this endpoint refuses" and "the endpoint it currently happens to forward to refuses".
  const { setSetting } = await actions()

  await assert.rejects(() => setSetting(SAMPLES.plugin, 'true'))

  assert.deepEqual(state.permissions, [], 'refused before setSettings was entered at all')
  assert.deepEqual(state.writes, [])
  assert.equal(state.transactions, 0)
})

test('an ordinary preference key still writes through BOTH generic writers', async () => {
  // Non-vacuity. A guard that refused everything would pass every assertion above.
  const { setSetting, setSettings } = await actions()

  assert.deepEqual(await setSetting('financial_year_start', '04-01'), { status: 'saved' })
  assert.deepEqual(state.writes, ['financial_year_start=04-01'])
  assert.deepEqual(state.permissions, ['settings.company'], 'and it did go through the gate')

  reset()
  assert.deepEqual(
    await setSettings({ retention_webhook_events_months: '6', retention_wms_events_months: '9' }),
    { status: 'saved' },
  )
  assert.deepEqual(state.writes, ['retention_webhook_events_months=6', 'retention_wms_events_months=9'])
})

test('every family named in the module is actually reserved', async () => {
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
      assert.ok(reservedSettingKeyRefusal(key), `${family}: ${key} must be reserved`)
      assert.ok(RESERVED_SETTING_KEYS.includes(key), `${family}: ${key} must be listed`)
      checked += 1
    }
  }
  // The families' own constants supply the keys, so a key added to a family is covered here without
  // this file changing — but only if the walk actually reached them.
  assert.equal(checked, RESERVED_SETTING_KEYS.length, 'every reserved key belongs to a named family')
  assert.ok(checked >= 12, `the walk reached ${checked} keys`)
})

test('the run-time-built dispatch dedupe key is refused by its family prefix', () => {
  // `wms_dispatch_unresolved_drift:<connector>:<date>` does not exist until the day it is claimed,
  // so no exact list can hold it. Writing one by hand silences that day's unresolved-drift alert.
  const built = `wms_dispatch_unresolved_drift:mintsoft:${new Date().toISOString().slice(0, 10)}`
  assert.ok(reservedSettingKeyRefusal(built), 'the built key is refused')
  assert.equal(reservedSettingKeyRefusal('wms_dispatch_unresolved_drift'), null, 'the bare stem is not the family')

  // And the prefix is the one the sweep actually builds — checked against the source, because the
  // key is interpolated inline and there is no constant to import.
  const sweep = readFileSync(join(REPO, 'lib/domain/wms/dispatch-sweep.ts'), 'utf8')
  for (const prefix of RESERVED_SETTING_KEY_PREFIXES) {
    assert.ok(
      sweep.includes(`\`${prefix}`),
      `no writer builds keys under '${prefix}' — a prefix that matches nothing protects nothing`,
    )
  }
})

test('an ordinary preference key is NOT reserved', () => {
  for (const key of ['retention_webhook_events_months', 'financial_year_start', 'invoice_trigger', 'public_app_url']) {
    assert.equal(reservedSettingKeyRefusal(key), null, `${key} is an operator preference`)
  }
})
