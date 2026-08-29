import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import test, { mock } from 'node:test'

import {
  PREFERENCE_KEYS_BY_SCREEN,
  WRITABLE_SETTING_KEYS,
  screenOfferingSettingKey,
  settingKeyWriteRefusal,
} from '@/lib/domain/settings/writable-setting-keys'
import { RESERVED_SETTING_KEYS } from '@/lib/domain/settings/reserved-setting-keys'
import { WC_SETTINGS_VERSION_KEY } from '@/lib/connectors/woocommerce/sync-lock'

// ---------------------------------------------------------------------------
// Codex r20 HIGH — the generic settings writer's guard was the wrong SHAPE.
//
// r19 gave `setSetting`/`setSettings` a DENYLIST of the system-managed families. r20's point is that
// a denylist over a growing key space is only ever as complete as the last search for keys, and this
// one had already failed: `MACHINE_MANAGED_SYNC_KEYS` (app/actions/wc-sync.ts) was never in it. So
// `wc_initial_import_completed` — the completion flag THIS BRANCH had just made refusal-blocking —
// plus the WooCommerce sync cursors and the `wc_url`/`wc_consumer_*` credential rows were all
// writable by any principal holding `settings.company`.
//
// The guard is now an ALLOWLIST of the preferences the settings UI offers. These tests are the
// adversarial coverage r20 asked for, and every family is driven from the constants or the SOURCE
// that owns it — never from the allowlist itself, which would only prove the list agrees with
// itself.
//
// WHAT THESE TESTS PIN, and the route each takes:
//   1. `wc_initial_import_completed` refused through BOTH writers   (setSetting / setSettings → assertWritableSettingKeys)
//   2. every WC sync key, machine-managed included, refused through
//      both writers — driven from wc-sync.ts's own source           (both writers → settingKeyWriteRefusal)
//   3. the WooCommerce connector credential rows refused through
//      both writers                                                 (both writers → settingKeyWriteRefusal)
//   4. runtime-BUILT WMS drift state refused through both writers   (both writers → settingKeyWriteRefusal)
//   5. an ordinary preference the UI offers still saves through
//      both writers                                                 (non-vacuity)
//   6. an unrecognised key nobody has classified is refused too     (settingKeyWriteRefusal, the inversion itself)
//   7. the allowlist is LEVEL WITH THE UI: exactly the screens that
//      import a generic writer, and each key really in its screen    (repository walk)
//   8. no system-managed key has leaked onto the allowlist          (cross-check against owning lists)
// ---------------------------------------------------------------------------

const REPO = process.cwd()

const state = {
  /** Every settings row written, in commit order. A refusal must leave this empty. */
  writes: [] as string[],
  /** Permissions demanded, in order. Used to tell WHICH writer refused — see test 1. */
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

/**
 * Prove BOTH generic writers refuse `key`, and that neither committed anything.
 *
 * Both routes are asserted for every family, not just for one sample, because they are two
 * separately addressable server actions: `setSetting` has its own assertion line, and a guard that
 * only ran in the one it currently delegates to is one refactor away from being no guard at all.
 * `setSetting`'s refusal is distinguishable — `setSettings` awaits requirePermission BEFORE it
 * checks the key, so a refusal that came from the delegation would have recorded a permission
 * check first, and one from `setSetting`'s own line records none.
 */
async function bothWritersRefuse(key: string, why: string) {
  const { setSetting, setSettings } = await actions()

  reset()
  await assert.rejects(() => setSettings({ [key]: 'x' }), `${why}: setSettings must refuse ${key}`)
  assert.deepEqual(state.writes, [], `${key}: setSettings committed nothing`)
  assert.equal(state.transactions, 0, `${key}: setSettings opened no transaction`)

  reset()
  await assert.rejects(() => setSetting(key, 'x'), `${why}: setSetting must refuse ${key}`)
  assert.deepEqual(state.writes, [], `${key}: setSetting committed nothing`)
  assert.equal(state.transactions, 0, `${key}: setSetting opened no transaction`)
  assert.deepEqual(state.permissions, [], `${key}: setSetting refused on its OWN line, before delegating`)
}

/** Quoted string literals inside a named `const NAME = [...]` / `new Set([...])` block of a source file. */
function keysInSourceConst(file: string, name: string): string[] {
  const source = readFileSync(join(REPO, file), 'utf8')
  const start = source.indexOf(`const ${name}`)
  assert.notEqual(start, -1, `${file} no longer declares ${name} — this test was reading a list that has moved`)
  const open = source.indexOf('[', start)
  const close = source.indexOf(']', open)
  assert.ok(open !== -1 && close > open, `${file}: ${name} is not the array literal this test assumes`)
  return [...source.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test.beforeEach(reset)

// ---------------------------------------------------------------------------
// 1. The interaction that made this a HIGH.
// ---------------------------------------------------------------------------

test('wc_initial_import_completed cannot be set through either generic writer', async () => {
  // This branch made the flag refusal-blocking: `startInitialImport` withholds it when a refusal
  // could not be persisted, so the import is re-attempted rather than silently declared done. A
  // caller with `settings.company` writing the flag directly bypasses that protection in one call,
  // and `startInitialImport()` then returns without importing the existing orders.
  await bothWritersRefuse(
    'wc_initial_import_completed',
    'the initial-import completion flag is machine state, not a preference',
  )

  // And it is refused for the right reason: it is not an offered preference, whoever else may or
  // may not have remembered to list it somewhere.
  assert.equal(screenOfferingSettingKey('wc_initial_import_completed'), null)
  assert.ok(settingKeyWriteRefusal('wc_initial_import_completed'))
})

// ---------------------------------------------------------------------------
// 2. Completion flags and sync cursors — driven from wc-sync.ts's OWN lists.
// ---------------------------------------------------------------------------

test('every WooCommerce sync setting is refused, driven from wc-sync.ts rather than from the allowlist', async () => {
  // `MACHINE_MANAGED_SYNC_KEYS` is the list the r19 denylist missed. Reading it from the source that
  // owns it means a cursor added there is covered here without this file changing — which is the
  // property the denylist never had.
  const machineManaged = keysInSourceConst('app/actions/wc-sync.ts', 'MACHINE_MANAGED_SYNC_KEYS')
  const allSyncKeys = keysInSourceConst('app/actions/wc-sync.ts', 'SYNC_SETTING_KEYS')

  assert.ok(machineManaged.includes('wc_initial_import_completed'), 'the flag is still declared machine-managed')
  assert.ok(machineManaged.includes('last_wc_order_sync_at'), 'the order cursor is still declared machine-managed')
  assert.ok(machineManaged.length >= 10, `read ${machineManaged.length} machine-managed keys`)
  assert.ok(allSyncKeys.length >= 19, `read ${allSyncKeys.length} sync keys`)
  for (const key of machineManaged) {
    assert.ok(allSyncKeys.includes(key), `${key} is machine-managed but no longer a sync key — the walk drifted`)
  }

  // The WHOLE family, not only the machine-managed half. The sync PREFERENCES have an owning writer
  // too (`saveSyncSettings`) behind a different permission — `sync`, not `settings.company` — so
  // reaching any of them through this endpoint is a privilege crossing as well as a bypass.
  for (const key of allSyncKeys) {
    await bothWritersRefuse(key, 'WooCommerce sync state belongs to app/actions/wc-sync.ts')
  }
})

// ---------------------------------------------------------------------------
// 3. Connector credentials.
// ---------------------------------------------------------------------------

test('WooCommerce connector credential rows are refused by both generic writers', async () => {
  // `saveWcCredentials` validates the URL, demands fresh authentication, holds the sync advisory
  // lock, wipes the product-id cache and bumps `wc_settings_version`. A generic upsert does none of
  // it, so an in-flight stock sync keeps writing old-store ids against the new store.
  const credentialKeys = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret', WC_SETTINGS_VERSION_KEY]

  const wcSync = readFileSync(join(REPO, 'app/actions/wc-sync.ts'), 'utf8')
  for (const key of ['wc_url', 'wc_consumer_key', 'wc_consumer_secret']) {
    assert.ok(wcSync.includes(`'${key}'`), `${key} is no longer written by wc-sync.ts — this test names a dead row`)
  }

  for (const key of credentialKeys) {
    await bothWritersRefuse(key, 'connector credentials belong to saveWcCredentials')
  }
})

// ---------------------------------------------------------------------------
// 4. Runtime-BUILT WMS state — the family no exact list can ever hold.
// ---------------------------------------------------------------------------

test('runtime-built WMS drift state is refused by both generic writers', async () => {
  // Neither key exists until a sweep claims it, so no denylist could enumerate them. Under the
  // allowlist they need no entry at all: they are not offered preferences, so they are refused.
  const today = new Date().toISOString().slice(0, 10)
  const built = [
    `wms_dispatch_unresolved_streak:mintsoft`,
    `wms_dispatch_unresolved_drift:mintsoft:${today}`,
    // A connector nobody has integrated yet is refused on exactly the same footing, which is the
    // whole claim: the writer does not have to recognise a key to refuse it.
    `wms_dispatch_unresolved_streak:a-connector-added-next-year`,
  ]

  for (const key of built) {
    await bothWritersRefuse(key, 'drift state is claimed by the sweep, not typed by an operator')
  }

  // The families are real: some writer actually builds keys under each prefix. A prefix that
  // matched nothing would make the refusal MESSAGE fiction even though the refusal stands.
  const builders: Array<[string, string]> = [
    ['wms_dispatch_unresolved_drift:', 'lib/domain/wms/dispatch-sweep.ts'],
    ['wms_dispatch_unresolved_streak:', 'lib/domain/wms/unresolved-drift.ts'],
  ]
  for (const [prefix, file] of builders) {
    const source = readFileSync(join(REPO, file), 'utf8')
    assert.ok(source.includes(`\`${prefix}`), `${file} no longer builds keys under '${prefix}'`)
  }
})

// ---------------------------------------------------------------------------
// 5 & 6. Non-vacuity, and the inversion itself.
// ---------------------------------------------------------------------------

test('an ordinary preference the UI offers still saves through BOTH generic writers', async () => {
  // Non-vacuity, and it is the assertion that would catch the allowlist being too NARROW: a guard
  // that refused everything would pass every refusal test above while breaking every settings
  // screen. Both keys below are read from the allowlist's own screen manifest, so this exercises a
  // key the UI genuinely offers rather than one invented here.
  const [firstScreen, firstKeys] = Object.entries(PREFERENCE_KEYS_BY_SCREEN)[0]
  const single = firstKeys[0]
  assert.ok(single, `${firstScreen} declares no keys`)

  const { setSetting, setSettings } = await actions()

  assert.deepEqual(await setSetting(single, '30'), { status: 'saved' })
  assert.deepEqual(state.writes, [`${single}=30`])
  assert.deepEqual(state.permissions, ['settings.company'], 'and it did go through the gate')

  reset()
  assert.deepEqual(
    await setSettings({ retention_webhook_events_months: '6', financial_year_start: '04-01' }),
    { status: 'saved' },
  )
  assert.deepEqual(state.writes, ['retention_webhook_events_months=6', 'financial_year_start=04-01'])

  // A group that mixes an offered preference with machine state takes the WHOLE save down, before
  // the transaction — the atomic writer must not store the neighbours of a refused key.
  reset()
  await assert.rejects(() =>
    setSettings({ financial_year_start: '04-01', wc_initial_import_completed: 'true' }))
  assert.deepEqual(state.writes, [])
  assert.equal(state.transactions, 0)
})

test('a key nobody has classified is refused, and the refusal says where to put it', async () => {
  // THE INVERSION, stated as a test. The denylist could only refuse what someone had already
  // decided to fear; this refuses a key invented thirty seconds ago and never mentioned anywhere.
  const invented = 'some_future_machine_state_nobody_listed'
  const refusal = settingKeyWriteRefusal(invented)
  assert.ok(refusal, 'an unrecognised key is refused')
  assert.match(refusal!, /not a writable preference key/)
  assert.match(refusal!, /writable-setting-keys\.ts/, 'and the message names where a real preference would go')

  await bothWritersRefuse(invented, 'unrecognised keys are refused by default')
})

// ---------------------------------------------------------------------------
// 7. The allowlist is level with the settings UI.
// ---------------------------------------------------------------------------

test('the allowlist names exactly the screens that call a generic settings writer', () => {
  // The list only stays honest if it cannot drift from the UI in EITHER direction: a new screen
  // that saves a key nobody listed would fail at run time in front of the operator, and a key left
  // behind by a deleted screen would be an endpoint nothing can reach and nobody would remove.
  // Every root a caller could live in, not just the two the screens happen to occupy today. A
  // `lib/` or `scripts/` module that reached for a generic writer would be a caller with no screen
  // at all, and the point of this test is that it cannot arrive unannounced.
  const roots = ['app', 'components', 'lib', 'scripts', 'hooks'].filter((root) => existsSync(join(REPO, root)))
  const importers: string[] = []
  let scanned = 0

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      scanned += 1
      const rel = relative(REPO, full)
      if (rel === 'app/actions/settings.ts') continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/app\/actions\/settings'/g)) {
        const bindings = match[1].split(',').map((b) => b.split(' as ')[0].trim())
        if (bindings.includes('setSetting') || bindings.includes('setSettings')) importers.push(rel)
      }
    }
  }
  for (const root of roots) walk(join(REPO, root))

  // The walk must have gone somewhere. Without this, a mistyped root would make every assertion
  // below compare two empty sets and pass.
  assert.ok(scanned > 200, `the walk reached only ${scanned} files`)
  assert.ok(importers.length >= 8, `found only ${importers.length} generic-writer callers`)

  assert.deepEqual(
    [...new Set(importers)].sort(),
    Object.keys(PREFERENCE_KEYS_BY_SCREEN).sort(),
    'every caller of setSetting/setSettings must declare its keys in writable-setting-keys.ts, and vice versa',
  )
})

test('every allowlisted key really appears in the screen it is filed under', () => {
  let checked = 0
  for (const [screen, keys] of Object.entries(PREFERENCE_KEYS_BY_SCREEN)) {
    const source = readFileSync(join(REPO, screen), 'utf8')
    assert.ok(keys.length > 0, `${screen}: an empty screen would assert nothing`)
    for (const key of keys) {
      // Bare word, not a quoted literal: several screens pass their keys as unquoted object
      // properties (`fx_schedule_enabled: isEnabled ? ...`) or by assignment
      // (`values.backup_s3_secret_key = ...`).
      assert.match(
        source,
        new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`),
        `${screen} does not mention ${key} — a preference no screen offers has no business on this list`,
      )
      checked += 1
    }
  }
  assert.equal(checked, WRITABLE_SETTING_KEYS.length, 'no key is filed under two screens or none')
  assert.ok(checked >= 32, `the walk reached ${checked} keys`)
})

// ---------------------------------------------------------------------------
// 8. Nothing system-managed has leaked onto the allowlist.
// ---------------------------------------------------------------------------

test('no system-managed key has leaked onto the allowlist', async () => {
  // THE CRON REGISTRY IS AN OWNER TOO (Codex r20 HIGH, second finding). The backup and FX schedule
  // switches were allowlisted for one round on the strength of "a screen offers them", and both were
  // duplicating enablement the registry owns — `backup_schedule_enabled` badly (a crontab line the
  // generic save never reconciled) and the FX pair not at all (no reader anywhere). Deriving the
  // scheduler's keys FROM THE REGISTRY is what stops that being re-reasoned into existence.
  const { getAllCronJobs } = await import('@/lib/cron-jobs')
  const cronJobs = getAllCronJobs()
  assert.ok(cronJobs.length >= 10, `the registry produced only ${cronJobs.length} jobs — the barrel did not register`)
  const schedulerKeys = cronJobs.flatMap((job) => [
    `cron_${job.settingKey}_enabled`,
    `cron_${job.settingKey}_schedule`,
    ...(job.legacyEnabledKey ? [job.legacyEnabledKey] : []),
  ])
  assert.ok(
    schedulerKeys.includes('backup_schedule_enabled'),
    'the backup job still declares its legacy enablement row — this cross-check names a live key',
  )

  const owned = new Set<string>([
    ...schedulerKeys,
    ...RESERVED_SETTING_KEYS,
    ...keysInSourceConst('app/actions/wc-sync.ts', 'SYNC_SETTING_KEYS'),
    'wc_url',
    'wc_consumer_key',
    'wc_consumer_secret',
    WC_SETTINGS_VERSION_KEY,
    // Owned by savePublicAppUrl, which validates the URL and reconciles the crontab that embeds it.
    'public_app_url',
    // Owned by app/actions/onboarding.ts.
    'onboarding_current_step',
    'onboarding_complete',
    'onboarding_dismissed',
  ])
  assert.ok(owned.size >= 50, `the cross-check assembled only ${owned.size} owned keys`)

  for (const key of WRITABLE_SETTING_KEYS) {
    assert.ok(!owned.has(key), `${key} has an owning writer and must not be generically writable`)
    assert.equal(settingKeyWriteRefusal(key), null, `${key} is allowlisted, so it must not be refused`)
  }
  for (const key of owned) {
    assert.ok(settingKeyWriteRefusal(key), `${key} has an owning writer and must be refused`)
  }
})
