import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-512h round 2, finding 3 — app/actions/accounting-sync.ts dispatchers.
 *
 * These exports were allowlisted in server-action-guard-coverage.test.ts with a
 * reason naming the delegate whose guard each "inherits". A dispatcher that
 * answers `if (!connector) return …` never reaches that delegate, so on exactly
 * the path an unauthorized caller takes there was no guard at all — the
 * justification was false where it mattered. Reaching the `!connector` branch
 * also means `isIntegrationPluginEnabled` already ran, i.e. the refused caller
 * got a database read and an oracle for whether an accounting integration is
 * configured.
 *
 * A written justification is not access control; neither is an allowlist entry.
 * Every dispatcher now carries the delegate's own gate, and the allowlist
 * entries are deleted.
 *
 * As with the other tests in this directory, only the session source is mocked
 * so the assertions are about the real RBAC decision: which principal, which
 * permission, and that nothing was read.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

const dbTouches: string[] = []
const dbProxy = new Proxy({}, {
  get(_t, model: string) {
    return new Proxy({}, {
      get(_t2, op: string) {
        return (...args: unknown[]) => {
          dbTouches.push(`${model}.${op}`)
          void args
          return Promise.resolve([])
        }
      },
    })
  },
})
mock.module('@/lib/db', { namedExports: { db: dbProxy } })

/**
 * The dispatchers whose `!connector` arm returns without ever reaching a
 * delegate — the ones the allowlist reason was actually false about. Each is
 * called with the arguments a real caller would pass.
 */
const EARLY_RETURN_DISPATCHERS: Array<{
  name: string
  call: (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
}> = [
  { name: 'getAccountingConnectionTestState', call: (m) => m.getAccountingConnectionTestState() },
  { name: 'testAccountingConnection', call: (m) => m.testAccountingConnection() },
  { name: 'saveAccountingConnectionSettings', call: (m) => m.saveAccountingConnectionSettings(...(['id', 'secret'] as never[])) },
  { name: 'connectAccountingConnector', call: (m) => m.connectAccountingConnector(...(['id', 'secret', 'https://ims.example.test'] as never[])) },
]

for (const { name, call } of EARLY_RETURN_DISPATCHERS) {
  test(`${name} refuses a WAREHOUSE session, naming the sync permission, without reaching the plugin-state read`, async () => {
    currentRole = 'WAREHOUSE'
    dbTouches.length = 0
    const mod = await import('@/app/actions/accounting-sync')

    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'sync')
        assert.match(error.message, /Forbidden: missing permission sync/)
        return true
      },
    )

    assert.deepEqual(
      dbTouches,
      [],
      `refused call must not read plugin state, but touched: ${dbTouches.join(', ')}`,
    )
  })
}

test('a refused dispatcher does not answer with the "Enable Xero or QuickBooks first" oracle', async () => {
  // The early-return arm is a fact about the tenant's configuration. Under the
  // old allowlist a WAREHOUSE session got that fact as a normal, non-throwing
  // result, which is why "it delegates to a guarded action" was never true here.
  currentRole = 'WAREHOUSE'
  const { testAccountingConnection } = await import('@/app/actions/accounting-sync')
  const outcome = await testAccountingConnection().then(
    (value) => ({ returned: value }),
    (error: unknown) => ({ threw: error }),
  )
  assert.ok('threw' in outcome, `expected a refusal, got: ${JSON.stringify(outcome)}`)
})

test('getAccountingSettingsMasked refuses a READONLY session naming the sync permission', async () => {
  currentRole = 'READONLY'
  dbTouches.length = 0
  const { getAccountingSettingsMasked } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => getAccountingSettingsMasked(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
  assert.deepEqual(dbTouches, [])
})

test('getAccountingSyncLogs refuses a SUPPLIER session naming the sync permission, before any plugin-state read', async () => {
  // This dispatcher always falls back to a delegate, so it refused even before
  // the fix — but only AFTER resolving the active connector, i.e. after a
  // database read on behalf of a principal that may not read anything here. The
  // dbTouches assertion is what distinguishes "the delegate eventually said no"
  // from "the dispatcher said no first".
  currentRole = 'SUPPLIER'
  dbTouches.length = 0
  const { getAccountingSyncLogs } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => getAccountingSyncLogs(5),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
  assert.deepEqual(
    dbTouches,
    [],
    `refused call must not resolve the active connector, but touched: ${dbTouches.join(', ')}`,
  )
})

test('previewMissingAccountingTaxRates refuses a MANAGER session, naming settings.company', async () => {
  // MANAGER holds 'sync' but not 'settings.company'. The dispatcher must match
  // the delegate it routes to (settings.ts:previewMissingXeroTaxRates), not the
  // permission its neighbours use — a guard copied from the wrong sibling would
  // widen reach while looking correct.
  currentRole = 'MANAGER'
  dbTouches.length = 0
  const { previewMissingAccountingTaxRates } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => previewMissingAccountingTaxRates(),
    (error: unknown) => {
      assert.equal((error as { permission?: string }).permission, 'settings.company')
      return true
    },
  )
  assert.deepEqual(
    dbTouches,
    [],
    `refused call must not resolve the active connector, but touched: ${dbTouches.join(', ')}`,
  )
})

test('MANAGER keeps the sync reach it legitimately had', async () => {
  // Too tight is also a defect. MANAGER holds 'sync', so the guarded dispatcher
  // must still run for them and return the ordinary not-configured answer.
  currentRole = 'MANAGER'
  const { getAccountingConnectionTestState } = await import('@/app/actions/accounting-sync')
  assert.deepEqual(await getAccountingConnectionTestState(), {
    status: 'never', testedAt: null, message: '', fingerprint: null,
  })
})

test('syncAccountingAccountBalanceSnapshots refuses a WAREHOUSE session before reading plugin state', async () => {
  // This one's delegate gates on requireRole('ADMIN','FINANCE'), which throws a
  // plain 'Forbidden' — requireRole carries no permission name in this codebase,
  // so the assertion is on the role decision and on nothing being read.
  currentRole = 'WAREHOUSE'
  dbTouches.length = 0
  const { syncAccountingAccountBalanceSnapshots } = await import('@/app/actions/accounting-sync')
  await assert.rejects(
    () => syncAccountingAccountBalanceSnapshots(),
    (error: unknown) => {
      assert.match(String((error as Error).message), /^Forbidden$/)
      return true
    },
  )
  assert.deepEqual(dbTouches, [])
})

test('syncAccountingAccountBalanceSnapshots still runs for FINANCE, which holds no sync permission', async () => {
  // The delegate admits ADMIN and FINANCE. Gating the dispatcher on 'sync' —
  // the permission every neighbouring dispatcher uses — would have locked
  // FINANCE out of its own balance snapshots. This is the case that proves the
  // guard matches the delegate rather than the file.
  currentRole = 'FINANCE'
  const { syncAccountingAccountBalanceSnapshots } = await import('@/app/actions/accounting-sync')
  const result = await syncAccountingAccountBalanceSnapshots()
  assert.deepEqual(result.errors, ['Enable Xero or QuickBooks first.'])
})

test('ADMIN reaches every guarded dispatcher', async () => {
  currentRole = 'ADMIN'
  const mod = await import('@/app/actions/accounting-sync')
  assert.deepEqual(await mod.testAccountingConnection(), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
  assert.deepEqual(await mod.saveAccountingConnectionSettings('id', 'secret'), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
  assert.deepEqual(await mod.connectAccountingConnector('id', 'secret', 'https://ims.example.test'), {
    success: false, error: 'Enable Xero or QuickBooks first.',
  })
})

// ---------------------------------------------------------------------------
// app/actions/accounting-batch.ts — the same defect, found while checking
// whether the accounting-sync allowlist reason was true anywhere else.
//
// These three carried NO guard and sat under `'accounting-batch.ts:*': connector
// facade → guarded daily-batch actions`. With neither connector active they
// answer from their own module (`emptyAccountingBatchPreview()` / `[]`), so on
// that arm there is no delegate to inherit from — after
// getActiveAccountingConnectorInfo has already read plugin state. Both branches'
// delegates gate on requirePermission('sync'), so that is now on the dispatcher
// and the allowlist entry is deleted.
// ---------------------------------------------------------------------------

const BATCH_DISPATCHERS: Array<{
  name: string
  call: (m: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
}> = [
  { name: 'getAccountingBatchPreview', call: (m) => m.getAccountingBatchPreview() },
  { name: 'getAccountingBatchHistory', call: (m) => m.getAccountingBatchHistory() },
  { name: 'refreshAccountingBatchPreview', call: (m) => m.refreshAccountingBatchPreview() },
]

for (const { name, call } of BATCH_DISPATCHERS) {
  test(`${name} refuses a WAREHOUSE session, naming the sync permission, without reading plugin state`, async () => {
    currentRole = 'WAREHOUSE'
    dbTouches.length = 0
    const mod = await import('@/app/actions/accounting-batch')

    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'expected an Error')
        assert.equal((error as { permission?: string }).permission, 'sync')
        assert.match(error.message, /Forbidden: missing permission sync/)
        return true
      },
    )

    assert.deepEqual(
      dbTouches,
      [],
      `refused call must not resolve the active connector, but touched: ${dbTouches.join(', ')}`,
    )
  })

  test(`${name} refuses a READONLY session too`, async () => {
    currentRole = 'READONLY'
    const mod = await import('@/app/actions/accounting-batch')
    await assert.rejects(
      () => call(mod as unknown as Record<string, (...a: never[]) => Promise<unknown>>),
      (error: unknown) => (error as { permission?: string }).permission === 'sync',
    )
  })
}

test('MANAGER keeps the daily-batch reach its delegate grants it', async () => {
  // Both delegates gate on 'sync', which MANAGER holds. Copying the ADMIN-only
  // gate the Xero *sync* actions use would have taken the batch dashboard away
  // from a role entitled to it.
  currentRole = 'MANAGER'
  const { getAccountingBatchHistory } = await import('@/app/actions/accounting-batch')
  assert.deepEqual(await getAccountingBatchHistory(), [])
})

test('ADMIN reaches the batch preview and gets the ordinary no-connector answer', async () => {
  currentRole = 'ADMIN'
  const { getAccountingBatchPreview } = await import('@/app/actions/accounting-batch')
  const preview = await getAccountingBatchPreview()
  assert.equal(typeof preview, 'object')
  assert.ok(preview !== null)
})
