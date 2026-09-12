import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-i0o6 r6 (Codex round 5, HIGH 1) — THE CRON RUNS ONE SWEEP, AND THAT IS A MONEY FACT.
 *
 * `app/api/cron/accounting-daily-batch` picks the FIRST enabled accounting plugin and RETURNS. A
 * second enabled plugin's daily-batch sweep therefore never runs — not "runs later", never — and a
 * plugin that is enabled but switched off does NOT hand the tick on to the next one either.
 *
 * That is what decides whether another ledger's missing Group A2 journal has anybody coming for it.
 * r5 zeroed those pounds in silence on the opposite assumption ("its own sweep will rebuild it"), so
 * the precedence is asserted here rather than left as a property of an if-chain: the route and both
 * recreate sweeps now read this one function, and if it ever starts falling through, the sweeps
 * would go quiet about debits nothing will ever raise.
 */
const state = {
  enabled: [] as string[],
  settings: {} as Record<string, string>,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (
          state.settings[where.key] != null ? { key: where.key, value: state.settings[where.key] } : null
        ),
      },
    },
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.enabled.includes(id) },
})

async function resolve() {
  const { resolveScheduledDailyBatchSweep } = await import('@/lib/domain/accounting/daily-batch-sweep-schedule')
  return resolveScheduledDailyBatchSweep()
}

const ON = { xero_daily_batch_enabled: 'true', xero_sync_enabled: 'true', quickbooks_daily_batch_enabled: 'true', quickbooks_sync_enabled: 'true' }

test('o3d-i0o6 r6: with both plugins enabled it is XERO\'s sweep that runs, and only Xero\'s', async () => {
  state.enabled = ['xero', 'quickbooks']
  state.settings = { ...ON }
  assert.deepEqual(await resolve(), { connector: 'xero' })
})

test('o3d-i0o6 r6: an enabled-but-switched-off Xero does NOT hand the tick to QuickBooks', async () => {
  // The load-bearing half. A fall-through here would make the QuickBooks sweep look scheduled — and
  // every Xero A2 batch it declines to rebuild would go unreported on the strength of a sweep that
  // is not running. The route returns its skip reason at this point, so this does too, verbatim.
  state.enabled = ['xero', 'quickbooks']
  state.settings = { ...ON, xero_daily_batch_enabled: 'false' }
  assert.deepEqual(await resolve(), { connector: null, reason: 'Xero daily batch disabled' })

  state.settings = { ...ON, xero_sync_enabled: 'false' }
  assert.deepEqual(await resolve(), { connector: null, reason: 'Xero sync disabled' })
})

test('o3d-i0o6 r6: QuickBooks is the scheduled sweep only when the Xero PLUGIN is off', async () => {
  state.enabled = ['quickbooks']
  state.settings = { ...ON }
  assert.deepEqual(await resolve(), { connector: 'quickbooks' })

  state.settings = { ...ON, quickbooks_sync_enabled: 'false' }
  assert.deepEqual(await resolve(), { connector: null, reason: 'QuickBooks sync disabled' })
})

test('o3d-i0o6 r6: no accounting plugin at all means no sweep is coming for anything', async () => {
  state.enabled = []
  state.settings = { ...ON }
  assert.deepEqual(await resolve(), { connector: null, reason: 'No accounting plugin enabled' })
})
