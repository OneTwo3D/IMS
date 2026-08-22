import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-tj6v follow-up: "Import order statuses" in Settings -> Sync -> WooCommerce
// governed the poll/reconcile sweeps but NOT the initial import, which fetched a
// hardcoded `processing,pending,on-hold`. So the one import that runs on every
// new installation ignored the filter an operator had just configured. These
// drive the real runInitialImport (through startInitialImport) and read back the
// `status` parameter it puts on the WooCommerce request.

type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const fetchCalls: Array<Record<string, string>> = []
const notifications: Array<{ type: string; message: string }> = []
const importedOrderIds: number[] = []
const wcOrders = { current: [] as Array<Record<string, unknown>> }

function settingRow(key: string): SettingRow | null {
  const value = settings.get(key)
  return value === undefined ? null : { key, value }
}

// `startInitialImport` hands the real work to next/server's `after`. Run it
// inline and keep the promise so the test awaits the job, not just the kick-off.
const deferred: Array<Promise<unknown>> = []
mock.module('next/server', {
  namedExports: {
    after: (fn: () => Promise<void> | void) => { deferred.push(Promise.resolve(fn())) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => settingRow(where.key),
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.map(settingRow).filter((row): row is SettingRow => row !== null),
        upsert: async ({ where, create, update }: {
          where: { key: string }
          create: SettingRow
          update: { value: string }
        }) => {
          settings.set(where.key, settings.has(where.key) ? update.value : create.value)
          return { key: where.key, value: settings.get(where.key) ?? '' }
        },
      },
      shoppingOrderLink: { findMany: async () => [] },
    },
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', {
  namedExports: {
    notify: (payload: { type: string; message: string }) => { notifications.push(payload) },
  },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      fetchCalls.push(params)
      return { data: wcOrders.current, totalPages: 1, totalItems: wcOrders.current.length }
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (order: { id: number }, run: () => Promise<unknown>) => {
      importedOrderIds.push(order.id)
      return { outcome: 'imported', result: await run(), compensationFailed: false }
    },
  },
})

async function runImport(orderStatusesSetting: string | null) {
  settings.clear()
  deferred.length = 0
  fetchCalls.length = 0
  notifications.length = 0
  importedOrderIds.length = 0
  if (orderStatusesSetting !== null) settings.set('wc_sync_order_statuses', orderStatusesSetting)

  const { startInitialImport, getInitialImportProgress } = await import(
    '@/lib/connectors/woocommerce/sync/initial-import'
  )
  await startInitialImport()
  await Promise.all(deferred)
  return getInitialImportProgress()
}

test('the initial import fetches the operator-selected statuses, not a hardcoded list', async () => {
  wcOrders.current = []
  await runImport('["processing","completed"]')

  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.status, 'processing,completed')
})

test('unticking a status stops the initial import fetching it', async () => {
  wcOrders.current = []
  await runImport('["processing"]')

  const status = fetchCalls[0]?.status ?? ''
  assert.equal(status, 'processing')
  // The exact statuses the old hardcoded list smuggled in past the filter.
  assert.equal(status.includes('pending'), false)
  assert.equal(status.includes('on-hold'), false)
})

test('an unset status setting still imports the default, so an upgrade is not a behaviour change', async () => {
  wcOrders.current = []
  await runImport(null)

  assert.equal(fetchCalls[0]?.status, 'processing')
})

test('the initial import does not ask WooCommerce for the withdrawal statuses', async () => {
  wcOrders.current = []
  await runImport('["processing"]')

  const status = fetchCalls[0]?.status ?? ''
  assert.equal(status.includes('pending-wdraw'), false)
  assert.equal(status.includes('withdrawn'), false)
})

test('no statuses selected imports nothing rather than everything, and does not unlock live sync', async () => {
  // `[]` used to reach `status=` on the WooCommerce query, where an empty status
  // means ANY status — so unticking every box imported the entire store.
  wcOrders.current = [{ id: 1, number: '1', status: 'cancelled' }]
  const progress = await runImport('[]')

  assert.equal(fetchCalls.length, 0, 'WooCommerce is never asked for orders')
  assert.equal(importedOrderIds.length, 0, 'nothing is imported')
  assert.equal(progress.status, 'error')
  assert.match(progress.message, /No order statuses are selected/)
  assert.equal(
    settings.get('wc_initial_import_completed'),
    undefined,
    'live order sync stays gated off, so the operator can tick a status and retry',
  )
  assert.equal(notifications.at(-1)?.type, 'error')
})
