import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { aeliaAnswer, createFxSourceFakeDb } from '@/tests/helpers/fx-source-fake-db'
import { outboundHeldMessage } from '@/lib/security/outbound-write-hold-constants'

/**
 * A returned failure is not a discarded one. pushFxRatesToConnectors() returns each connector's push error (and logs it FAILED) without throwing; the FX
 * refresh used to ignore that result, so the fx-rates cron answered 200 for a WooCommerce push that failed. The rate fetch succeeds in every case here.
 * Database, transport and facade are faked; the refresh, the cron route and its mapping are real.
 */

process.env.SETTINGS_ENCRYPTION_KEY ??= 'a'.repeat(64)

const ACTIVE = [{ code: 'GBP', active: true }, { code: 'EUR', active: true }]
let fake = createFxSourceFakeDb({ currencies: ACTIVE, settings: {} })
let pushResults: Array<{ connector: string; supported: boolean; pushed: number; errors: string[] }> = []
let pushThrows = false
const recorded: string[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_t, key) => {
        if (key === '$transaction') {
          // The fake's own transaction (the rate table lock needs its raw-query members), with the cron run log added.
          const extras: Record<string, unknown> = { cronRun: { create: async (args: { data: { status: string } }) => { recorded.push(args.data.status) } }, activityLog: { create: async () => ({}) } }
          return async (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            (fake.db as unknown as { $transaction: (f: (tx: unknown) => Promise<unknown>, ...r: unknown[]) => Promise<unknown> }).$transaction(
              (tx) => fn(new Proxy(tx as object, { get: (target, name) => (name in extras ? extras[name as string] : (target as never)[name]) })), ...rest)
        }
        return (fake.db as never)[key]
      },
    }),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {}, notifyActiveAdmins: async () => {} } })
mock.module('@/lib/shopping', {
  namedExports: {
    pushFxRatesToConnectors: async () => {
      if (pushThrows) throw new Error('facade exploded')
      return pushResults
    },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-import', { namedExports: { retryPendingWcOrdersWaitingForFx: async () => ({ attempted: 0, imported: 0, stillPending: 0, failed: 0 }) } })
mock.module('@/lib/domain/accounting/receipt-registration-sweep', { namedExports: { sweepUnregisteredReceipts: async () => ({ scanned: 0, registered: 0, failed: 0 }) } })
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })

const realFetch = globalThis.fetch
test.beforeEach(() => {
  fake = createFxSourceFakeDb({ currencies: ACTIVE, settings: {} })
  recorded.length = 0
  pushThrows = false
  globalThis.fetch = (async () => new Response(JSON.stringify({ rates: { EUR: 1.1 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
})
test.afterEach(() => { globalThis.fetch = realFetch })

const status = async (): Promise<number> => {
  const { GET } = await import('@/app/api/cron/fx-rates/route')
  return (await GET(new Request('http://localhost/api/cron/fx-rates'))).status
}
const held = outboundHeldMessage({ connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'POST', target: 'https://shop.example.test/x', hop: 0 })

test('fx-rates: the rate fetch succeeds and the WooCommerce push returns an error: 500, recorded failed', async () => {
  pushResults = [{ connector: 'woocommerce', supported: true, pushed: 0, errors: ['WC API error: 500 boom'] }]
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(result.success, true, 'the rate fetch itself succeeded (the test is not vacuous)')
  assert.deepEqual(result.updated, ['EUR'])
  assert.equal(result.connectorPushFailures, 1)
  fake = createFxSourceFakeDb({ currencies: ACTIVE, settings: {} })
  assert.equal(await status(), 500)
  assert.equal(recorded.at(-1), 'failed')
})

test('fx-rates: a push the outbound hold refused is held (200); a held push beside a genuine one is 500; a fan-out that threw is 500; a clean push is 200', async () => {
  pushResults = [{ connector: 'woocommerce', supported: true, pushed: 0, errors: [held] }]
  assert.equal(await status(), 200)
  pushResults = [{ connector: 'woocommerce', supported: true, pushed: 0, errors: [held, 'WC API error: 500 boom'] }]
  assert.equal(await status(), 500)
  pushResults = []
  pushThrows = true
  assert.equal(await status(), 500)
  pushThrows = false
  pushResults = [{ connector: 'woocommerce', supported: true, pushed: 3, errors: [] }]
  assert.equal(await status(), 200)
})
