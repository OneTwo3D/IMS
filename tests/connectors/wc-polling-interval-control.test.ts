import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-potv: `wc_sync_interval_minutes` was an editable "Polling interval (minutes)" number
 * input on Settings -> Sync -> WooCommerce that NOTHING read.
 *
 * The real cadence is the `wc-reconcile` cron schedule (lib/cron-jobs/woocommerce.ts,
 * defaultSchedule `0 4 * * *`), edited in Settings -> System -> Scheduler. An operator who
 * set the interval to 5 minutes after a webhook outage got a DAILY 04:00 reconcile and was
 * never told.
 *
 * WHY REMOVED RATHER THAN WIRED UP. The cadence is genuinely owned by the cron registry: the
 * schedule is a cron expression stored as `cron_wc_reconcile_schedule`, with its own enable
 * flag and crontab sync. Driving that from a second minutes field would give ONE fact TWO
 * writers with no defined precedence — and the job it would have to drive does far more than
 * poll orders (held sales-invoice releases, the product poll, the stock reconcile), so an
 * "order polling interval" cannot express its cadence anyway. One control, one place.
 *
 * These tests assert the OPERATOR-VISIBLE consequences, not the absence of a string in
 * app/actions/wc-sync.ts: what the settings form is given, what a save actually persists,
 * what the form renders, and that every operator-facing pointer to the cadence names a page
 * that exists.
 */

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'admin' } }),
    requireFreshPermission: async () => ({ user: { id: 'admin' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

const state = {
  settings: [] as Array<{ key: string; value: string }>,
  transactions: 0,
  upserts: [] as Array<{ key: string; value: string }>,
}

const settingDelegate = {
  findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
    const wanted = where?.key?.in
    return state.settings
      .filter((row) => (wanted ? wanted.includes(row.key) : true))
      .map((row) => ({ ...row }))
  },
  findUnique: async ({ where }: { where: { key: string } }) =>
    state.settings.find((row) => row.key === where.key) ?? null,
  updateMany: async () => ({ count: 0 }),
  upsert: ({ where, update }: { where: { key: string }; update: { value: string } }) => {
    // Prisma delegates return a thenable that only executes inside `$transaction`; recording
    // at build time proves the write was PREPARED, and `transactions` proves it was executed.
    state.upserts.push({ key: where.key, value: update.value })
    return { key: where.key }
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: settingDelegate,
      $transaction: async (ops: unknown) => {
        state.transactions += 1
        return Array.isArray(ops) ? ops : []
      },
    },
  },
})

// Neither the currency probe nor the connection gate is what these tests are about; they must
// simply never be the reason a save is refused.
mock.module('@/lib/connectors/woocommerce/connection-test-gate', {
  namedExports: {
    buildWooCommerceConnectionFingerprint: () => 'fingerprint',
    evaluateWooCommerceEnableConnectionGate: async () => ({ ok: true }),
  },
})
mock.module('@/lib/integration-connection-test-gate', {
  namedExports: {
    getIntegrationConnectionTestState: async () => ({ status: 'passed' }),
    recordIntegrationConnectionTest: async () => {},
  },
})

const SYNC_CLIENT = join(process.cwd(), 'app/(dashboard)/sync/sync-client.tsx')
const SYSTEM_SETTINGS_PAGE = join(process.cwd(), 'app/(dashboard)/settings/system/page.tsx')
const WOOCOMMERCE_DOC = join(process.cwd(), 'help-docs/woocommerce.md')

function readRepoFile(path: string): string {
  const src = readFileSync(path, 'utf8')
  // A guard that reads an empty or missing file passes by accident. Assert the subject was
  // really loaded before asserting anything about its contents.
  assert.ok(src.length > 2000, `${path} should have been read, got ${src.length} bytes`)
  return src
}

function reset() {
  state.settings = [
    { key: 'wc_sync_order_statuses', value: '["processing"]' },
    { key: 'wc_sync_interval_minutes', value: '5' },
  ]
  state.transactions = 0
  state.upserts = []
}

test('o3d-potv: the settings the WooCommerce sync page is given carry no polling-interval field', async () => {
  reset()
  const { getWcSyncSettings } = await import('@/app/actions/wc-sync')

  const settings = await getWcSyncSettings()

  // A stored row survives the removal (nothing deletes it), so the assertion has to be about
  // what the page is HANDED, not about what the table holds.
  assert.equal(
    'wc_sync_interval_minutes' in settings,
    false,
    'a field no runtime reader consults must not be offered to the settings form',
  )
  // The control: the sibling setting on the same form is still delivered, so this is not a
  // test that passes because the whole settings read is broken.
  assert.equal(settings.wc_sync_order_statuses, '["processing"]')
})

test('o3d-potv: a posted polling interval is not persisted, and the same save still writes a real setting', async () => {
  reset()
  const { saveWcSyncSettings } = await import('@/app/actions/wc-sync')

  // Exactly what a stale browser tab (or a hand-made request) would send.
  const stalePayload = {
    wc_sync_interval_minutes: '5',
    wc_sync_product_direction: 'from_wc',
  } as unknown as Parameters<typeof saveWcSyncSettings>[0]

  const result = await saveWcSyncSettings(stalePayload)

  assert.deepEqual(result, { success: true })
  assert.equal(state.transactions, 1)
  // The real setting in the SAME payload proves the write path ran at all — without it this
  // assertion would also pass for a save that persisted nothing.
  assert.deepEqual(state.upserts, [{ key: 'wc_sync_product_direction', value: 'from_wc' }])
})

test('o3d-potv: the sync form offers no interval control, and names the schedule that does decide the cadence', async () => {
  const src = readRepoFile(SYNC_CLIENT)

  // Bindings, not mentions: the file still NAMES the removed key in the comment that explains
  // why it is gone, and that comment is worth more than a grep-clean file. What may not come
  // back is a control reading or writing it — and since `ShoppingSyncSettings` no longer has the
  // field, tsc refuses either of these too.
  assert.doesNotMatch(src, /s\.wc_sync_interval_minutes/, 'the phantom control must not be rendered')
  assert.doesNotMatch(src, /wc_sync_interval_minutes:/, 'nothing may write the phantom key back')
  assert.doesNotMatch(src, /Polling interval \(minutes\)/)
  // Naming the job and the page is the whole remedy: an operator who came here to speed the
  // sweep up has to leave knowing where the cadence actually lives.
  assert.match(src, /WooCommerce Reconcile/)
  assert.match(src, /\/settings\/system\?tab=scheduler/)
})

test('o3d-potv: every operator-facing pointer at the WooCommerce polling cadence names a page that exists', async () => {
  const { RETIRED_ENV_VARS } = await import('@/lib/ops/retired-env-vars')
  const message = RETIRED_ENV_VARS.WC_POLL_INTERVAL_MINUTES

  assert.match(message, /wc-reconcile cron schedule/)
  // "Settings -> Cron" is not a page in this app, and pointing an operator at a tab that does
  // not exist replaces one phantom control with another (the mistake o3d-potv was found
  // preventing).
  assert.doesNotMatch(message, /Settings -> Cron/)
  assert.match(message, /Settings -> System -> Scheduler/)

  // And the tab it names is real, so this is a check on the destination rather than on two
  // copies of the same string.
  assert.match(readRepoFile(SYSTEM_SETTINGS_PAGE), /key: 'scheduler', label: 'Scheduler'/)
})

test('o3d-potv: the WooCommerce help doc no longer documents an editable sync interval', async () => {
  const doc = readRepoFile(WOOCOMMERCE_DOC)

  assert.doesNotMatch(doc, /\*\*Sync interval\*\*/)
  assert.doesNotMatch(doc, /polling interval field/)
  assert.match(doc, /WooCommerce Reconcile/)
})
