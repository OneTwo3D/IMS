import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

import {
  CONFIRMATION_REQUIRED_CODE,
  isExplicitlyConfirmed,
  typedConfirmationMatches,
} from '@/lib/typed-confirmation'

/**
 * The three confirmations added to the operator screens (Xero "Retry all failed", backup delete,
 * Mintsoft "Go live") are enforced in the server actions too, so a client that skips the dialog is
 * refused. These drive the REAL actions with only the auth, database, file location and activity log
 * replaced, and prove for each: no flag -> refused and nothing touched; flag -> proceeds; permission
 * check still runs first.
 */

type Permission = { kind: 'permission' | 'admin'; arg?: string }
const gates: Permission[] = []
let denyAll = false
const logs: string[] = []

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      gates.push({ kind: 'permission', arg: permission })
      if (denyAll) throw new Error('Forbidden')
      return { user: { id: 'user-1' } }
    },
    requireFreshPermission: async (permission: string) => {
      gates.push({ kind: 'permission', arg: permission })
      if (denyAll) throw new Error('Forbidden')
      return { user: { id: 'user-1' } }
    },
    requireFreshAdmin: async () => {
      gates.push({ kind: 'admin' })
      if (denyAll) throw new Error('Forbidden')
      return { user: { id: 'user-1' } }
    },
    requireAdmin: async () => ({ user: { id: 'user-1' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1' } }),
    requireRole: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { logs.push(entry.action) },
    logActivityPersisted: async (entry: { action: string }) => { logs.push(entry.action); return true },
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})

let failedRows = 0
const retryCalls: unknown[][] = []
let bindingRow: Record<string, unknown> | null = null
let dryRun: { id: string } | null = { id: 'job-1' }
const bindingUpdates: unknown[] = []
const db = {
  accountingSyncLog: { count: async () => failedRows },
  externalWmsBinding: {
    findFirst: async () => bindingRow,
    updateMany: async (args: unknown) => { bindingUpdates.push(args); return { count: 1 } },
  },
  wmsSyncJob: { findFirst: async () => dryRun },
}
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/connectors/accounting-registry', {
  namedExports: {
    ACCOUNTING_CONNECTORS: [{ id: 'xero' }],
    getAccountingConnector: () => ({
      retryFailedSync: async (...args: unknown[]) => { retryCalls.push(args); return { success: true, reset: failedRows } },
    }),
    getAccountingConnectorDefinition: () => ({ id: 'xero' }),
  },
})

mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async (id: string) => id === 'xero' } })

let backupDir = ''
mock.module('@/lib/backup-storage', { namedExports: { getBackupDir: () => backupDir } })

function reset() {
  gates.length = 0
  denyAll = false
  logs.length = 0
  retryCalls.length = 0
  bindingUpdates.length = 0
  failedRows = 0
  bindingRow = null
  dryRun = { id: 'job-1' }
}

test('PRECONDITION: the helpers accept only a literal true and an exact typed value', () => {
  assert.equal(isExplicitlyConfirmed({ confirmed: true }), true)
  for (const bad of [undefined, null, {}, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: false }, 'yes']) {
    assert.equal(isExplicitlyConfirmed(bad), false)
  }
  assert.equal(typedConfirmationMatches('MIL1', 'MIL1'), true)
  assert.equal(typedConfirmationMatches('  MIL1 ', 'MIL1'), true, 'surrounding whitespace is forgiven')
  assert.equal(typedConfirmationMatches('mil1', 'MIL1'), false, 'case matters')
  assert.equal(typedConfirmationMatches('', ''), false, 'an empty expected value never matches')
  assert.equal(typedConfirmationMatches(undefined, 'MIL1'), false)
})

// ---------------------------------------------------------------------------------------------
// Backup delete
// ---------------------------------------------------------------------------------------------
test('deleteBackup refuses without a confirmation, with a wrong name, and deletes nothing', async () => {
  backupDir = await mkdtemp(path.join(os.tmpdir(), 'ux2-backups-'))
  try {
    const { deleteBackup } = await import('@/app/actions/backup')
    reset()
    const file = 'backup-2026-11-10.sql'
    await writeFile(path.join(backupDir, file), '-- sql')

    for (const confirmation of [undefined, { confirmed: true }, { confirmed: true, typedName: 'backup-other.sql' }, { confirmed: false, typedName: file }]) {
      const result = await deleteBackup(file, confirmation as never)
      assert.equal(result.success, false)
      assert.equal(result.code, CONFIRMATION_REQUIRED_CODE)
    }
    assert.deepEqual(await readdir(backupDir), [file], 'the file is still there')
    assert.deepEqual(logs, [], 'and no deletion was logged')

    const ok = await deleteBackup(file, { confirmed: true, typedName: file })
    assert.equal(ok.success, true)
    assert.deepEqual(await readdir(backupDir), [])
    assert.deepEqual(logs, ['backup_deleted'])
  } finally {
    await rm(backupDir, { recursive: true, force: true })
  }
})

test('deleteBackup still checks the admin gate first: an unauthorised caller is refused as Unauthorized, not told about confirmation', async () => {
  backupDir = await mkdtemp(path.join(os.tmpdir(), 'ux2-backups-'))
  try {
    const { deleteBackup } = await import('@/app/actions/backup')
    reset()
    denyAll = true
    const file = 'backup-x.sql'
    await writeFile(path.join(backupDir, file), '-- sql')
    const result = await deleteBackup(file, { confirmed: true, typedName: file })
    assert.deepEqual(result, { success: false, error: 'Unauthorized' })
    assert.deepEqual(gates, [{ kind: 'admin' }])
    assert.deepEqual(await readdir(backupDir), [file])
  } finally {
    await rm(backupDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// Xero "Retry all failed"
// ---------------------------------------------------------------------------------------------
test('retryFailedAccountingSync (bulk) refuses without a confirmation and re-queues nothing', async () => {
  const { retryFailedAccountingSync } = await import('@/app/actions/accounting-sync')
  reset()
  failedRows = 4
  for (const confirmation of [undefined, { confirmed: true }, { confirmed: false, expectedCount: 4 }]) {
    const result = await retryFailedAccountingSync(undefined, undefined, confirmation as never)
    assert.equal(result.success, false)
    assert.equal(result.code, CONFIRMATION_REQUIRED_CODE)
    assert.equal(result.reset, 0)
  }
  assert.deepEqual(retryCalls, [], 'the connector was never asked to retry')
})

test('retryFailedAccountingSync (bulk) refuses when the failed-row count changed since the operator confirmed', async () => {
  const { retryFailedAccountingSync } = await import('@/app/actions/accounting-sync')
  reset()
  failedRows = 6
  const result = await retryFailedAccountingSync(undefined, undefined, { confirmed: true, expectedCount: 4 })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /changed from 4 to 6/)
  assert.deepEqual(retryCalls, [])
})

test('retryFailedAccountingSync (bulk) proceeds with a matching confirmation; the permission gate ran first', async () => {
  const { retryFailedAccountingSync } = await import('@/app/actions/accounting-sync')
  reset()
  failedRows = 4
  const result = await retryFailedAccountingSync(undefined, undefined, { confirmed: true, expectedCount: 4 })
  assert.equal(result.success, true)
  assert.deepEqual(retryCalls, [[undefined, undefined]])
  assert.deepEqual(gates[0], { kind: 'permission', arg: 'sync' })
})

test('retryFailedAccountingSync (bulk) with no permission is refused before the confirmation is even read', async () => {
  const { retryFailedAccountingSync } = await import('@/app/actions/accounting-sync')
  reset()
  denyAll = true
  await assert.rejects(() => retryFailedAccountingSync(undefined, undefined, { confirmed: true, expectedCount: 0 }), /Forbidden/)
  assert.deepEqual(retryCalls, [])
})

test('a per-row retry is unchanged: it needs no bulk confirmation', async () => {
  const { retryFailedAccountingSync } = await import('@/app/actions/accounting-sync')
  reset()
  const result = await retryFailedAccountingSync('row-1', 2)
  assert.equal(result.success, true)
  assert.deepEqual(retryCalls, [['row-1', 2]])
})

// ---------------------------------------------------------------------------------------------
// Mintsoft go-live
// ---------------------------------------------------------------------------------------------
const alignBinding = () => ({
  id: 'bind-1',
  warehouseId: 'wh-1',
  stockSyncMode: 'ALIGN_TO_WMS',
  alignmentConfirmedAt: null,
  warehouse: { code: 'MIL1' },
})

test('confirmMintsoftAlignmentMode refuses without a confirmation or with the wrong warehouse code, and arms nothing', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  reset()
  bindingRow = alignBinding()
  for (const confirmation of [undefined, { confirmed: true }, { confirmed: true, typedName: 'CBG' }, { confirmed: true, typedName: 'mil1' }]) {
    const result = await confirmMintsoftAlignmentMode('bind-1', confirmation as never)
    assert.equal(result.success, false)
    assert.equal(result.code, CONFIRMATION_REQUIRED_CODE)
  }
  assert.deepEqual(bindingUpdates, [], 'alignmentConfirmedAt was never written')
  assert.deepEqual(logs, [])
})

test('confirmMintsoftAlignmentMode goes live with the typed warehouse code; the write permission is still required', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  reset()
  bindingRow = alignBinding()
  const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
  assert.deepEqual(result, { success: true })
  assert.equal(bindingUpdates.length, 1)
  assert.deepEqual(logs, ['mintsoft_alignment_confirmed'])
  assert.deepEqual(gates[0], { kind: 'permission', arg: 'settings.company' })

  reset()
  denyAll = true
  await assert.rejects(() => confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' }), /Forbidden/)
  assert.deepEqual(bindingUpdates, [])
})

test('confirmMintsoftAlignmentMode still requires a completed dry run even with a valid confirmation', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  reset()
  bindingRow = alignBinding()
  dryRun = null
  const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /dry run/)
  assert.deepEqual(bindingUpdates, [])
})
