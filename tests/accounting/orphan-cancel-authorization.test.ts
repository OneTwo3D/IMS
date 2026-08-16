import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { PermissionDeniedError, isAuthorizationDenial } from '@/lib/auth/session-gates'
import { getPermissions, hasPermission, type Permission } from '@/lib/permissions'

// ---------------------------------------------------------------------------
// o3d-osl8 round 5, finding 3 — the cancel control, its REAL gate, and what a role that cannot
// pass it is shown.
//
// THE BUG. `sync` gets a reader onto the Integrations page; cancelOrphanedAccountingSyncRows
// requires `settings`, which MANAGER does not hold. The banner rendered its cancel controls
// unconditionally, and that gate sits OUTSIDE the action's result-returning path — it throws. So a
// MANAGER click produced a REJECTED action inside startTransition: no error line, no notice,
// nothing at all.
//
// WHY THE EXISTING TESTS PASSED ANYWAY, and the reason this file exists: the page harness replaces
// cancelOrphanedAccountingSyncRows with a fake that authorises everybody and always returns
// `{ success: true }`. Every wiring assertion about the controls — which connector each sends,
// that a failure is displayed, that a success refreshes — was true of that fake and false of the
// product for MANAGER. A test that swaps a permissive double in for the gate under test proves
// nothing about the gate.
//
// So the gate here is the REAL one, and only the database and the activity log beneath it are
// faked.
// ---------------------------------------------------------------------------

const state = {
  role: 'ADMIN' as string,
  activeConnector: 'xero' as string | null,
  updates: [] as unknown[],
}

const accountingSyncLog = {
  updateMany: async (args: unknown) => { state.updates.push(args); return { count: 2 } },
  count: async () => 0,
}

/** The plugin rows as the locked `SELECT ... FOR UPDATE` returns them. */
function pluginRows() {
  return [
    { key: 'plugin_mintsoft_enabled', value: 'false' },
    { key: 'plugin_quickbooks_enabled', value: String(state.activeConnector === 'quickbooks') },
    { key: 'plugin_shiphero_enabled', value: 'false' },
    { key: 'plugin_shopify_enabled', value: 'false' },
    { key: 'plugin_woocommerce_enabled', value: 'false' },
    { key: 'plugin_xero_enabled', value: String(state.activeConnector === 'xero') },
  ]
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog,
      // $queryRaw answers the locked plugin-row read the action does inside its transaction
      // (o3d-osl8 round 6, finding 2). A double that returned [] here would make every role look
      // like "no accounting connector is active" and turn the ADMIN test below vacuous — it would
      // pass on the refusal path without ever reaching the update it claims to prove.
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ accountingSyncLog, $executeRaw: async () => 1, $queryRaw: async () => pluginRows() }),
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: state.role } }),
    // The REAL matrix and the REAL typed denial. Replaced only to choose the role.
    requirePermission: async (permission: Permission) => {
      if (!hasPermission(state.role, permission)) {
        throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
      }
      return { user: { id: 'u1', role: state.role } }
    },
    freshAuthFailureResult: () => null,
    PermissionDeniedError,
    isAuthorizationDenial,
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

async function cancel(connector?: string) {
  const { cancelOrphanedAccountingSyncRows } = await import('@/app/actions/accounting-sync')
  return cancelOrphanedAccountingSyncRows(connector)
}

test.beforeEach(() => {
  state.role = 'ADMIN'
  state.activeConnector = 'xero'
  state.updates = []
})

test('the mismatch this file is about: MANAGER holds `sync` and not `settings`', () => {
  assert.ok(getPermissions('MANAGER').has('sync'), 'so MANAGER reaches the page and SEES the banner')
  assert.ok(!getPermissions('MANAGER').has('settings'), 'and cannot run the cancel it was being offered')
  assert.ok(getPermissions('ADMIN').has('settings'))
})

test('ADMIN passes the REAL gate and the cancel runs', async () => {
  const result = await cancel('quickbooks')

  assert.equal(result.success, true)
  assert.equal(result.cancelled, 2)
  assert.equal(state.updates.length, 1, 'it really reached the update — the gate was passed, not absent')
})

test('MANAGER is REFUSED by the real gate, and refused by THROWING — which is why the UI must not offer it', async () => {
  state.role = 'MANAGER'

  await assert.rejects(
    () => cancel('quickbooks'),
    (error: unknown) => {
      assert.ok(isAuthorizationDenial(error), 'a typed denial')
      assert.equal((error as PermissionDeniedError).permission, 'settings')
      return true
    },
  )
  assert.deepEqual(state.updates, [], 'and nothing was written')
})

test('every role without `settings` is refused; the only role with it is ADMIN', async () => {
  for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER']) {
    state.role = role
    state.updates = []
    await assert.rejects(() => cancel('quickbooks'), (e: unknown) => isAuthorizationDenial(e), `${role} must be refused`)
    assert.deepEqual(state.updates, [], `${role} must write nothing`)
  }
})
