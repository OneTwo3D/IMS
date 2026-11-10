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

let failedIds: string[] = []
const candidateQueries: Array<Record<string, unknown>> = []
let bindingRow: Record<string, unknown> | null = null
type DryRunJob = { id: string; startedAt: Date; summary: Record<string, unknown> }
let dryRuns: DryRunJob[] = []
/** Runs between the approval's reads and its write — where a concurrent re-point lands. */
let betweenReadAndWrite: (() => void) | null = null
const bindingUpdates: unknown[] = []
const db = {
  accountingSyncLog: {
    // The confirmation check reads ids only; the candidate query carries an `id: { in }` filter or a row id.
    findMany: async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
      if (Object.keys(args.select).length === 1 && args.select.id === true) return failedIds.map((id) => ({ id }))
      candidateQueries.push(args.where)
      return []
    },
    findUnique: async () => null,
  },
  externalWmsBinding: {
    findFirst: async () => (bindingRow ? { ...bindingRow } : null),
    // Honours the compare-and-set: matches only while every field in `where` still equals the row.
    updateMany: async (args: { where: Record<string, unknown> }) => {
      betweenReadAndWrite?.()
      const row = bindingRow ?? {}
      const matches = Object.entries(args.where).every(([key, want]) => (want instanceof Date ? (row[key] as Date)?.getTime() === want.getTime() : row[key] === want))
      if (!matches) return { count: 0 }
      bindingUpdates.push(args)
      return { count: 1 }
    },
  },
  // Evaluates the REAL evidence query: start time after the pairing change and the summary stamps.
  wmsSyncJob: {
    findFirst: async (args: { where: { startedAt: { gt: Date }; AND: Array<{ summary: { path: string[]; equals: unknown } }> } }) => {
      return dryRuns.find((job) => job.startedAt > args.where.startedAt.gt
        && args.where.AND.every((clause) => job.summary[clause.summary.path[0]!] === clause.summary.equals)) ?? null
    },
  },
}
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async (id: string) => id === 'xero' } })

let backupDir = ''
mock.module('@/lib/backup-storage', { namedExports: { getBackupDir: () => backupDir } })

function reset() {
  gates.length = 0
  denyAll = false
  logs.length = 0
  candidateQueries.length = 0
  bindingUpdates.length = 0
  failedIds = []
  bindingRow = null
  dryRuns = [freshDryRun()]
  betweenReadAndWrite = null
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
// Xero "Retry all failed": enforced in the retry implementation, so EVERY entry point is covered
// ---------------------------------------------------------------------------------------------
type Retry = (entryId?: string, rev?: number, confirmation?: never) => Promise<{ success: boolean; reset: number; error?: string; code?: string }>
async function entryPoints(): Promise<Array<[string, Retry]>> {
  const wrapper = (await import('@/app/actions/accounting-sync')).retryFailedAccountingSync as unknown as Retry
  const direct = (await import('@/app/actions/xero-sync')).retryFailedXeroSync as unknown as Retry
  const { getAccountingConnector } = await import('@/lib/connectors/accounting-registry')
  const viaRegistry: Retry = (...args) => getAccountingConnector('xero').retryFailedSync(...(args as [never])) as never
  return [['retryFailedAccountingSync', wrapper], ['retryFailedXeroSync (exported action)', direct], ['connector registry retryFailedSync', viaRegistry]]
}

test('every bulk entry point refuses without a confirmation of the reviewed rows, and re-queues nothing', async () => {
  reset()
  failedIds = ['a', 'b']
  for (const [name, retry] of await entryPoints()) {
    for (const confirmation of [undefined, { confirmed: true }, { confirmed: false, rowIds: ['a', 'b'] }, { confirmed: true, rowIds: 'a,b' }, { confirmed: true, rowIds: ['a', ''] }]) {
      const result = await retry(undefined, undefined, confirmation as never)
      assert.equal(result.success, false, `${name} ${JSON.stringify(confirmation)}`)
      assert.equal(result.code, CONFIRMATION_REQUIRED_CODE, name)
    }
  }
  assert.deepEqual(candidateQueries, [], 'no candidate was ever selected for re-queueing')
})

test('a blank or whitespace row id is not a bulk request and not a row: every entry point refuses it', async () => {
  reset()
  failedIds = ['a', 'b']
  for (const [name, retry] of await entryPoints()) {
    for (const blank of ['', '   ', '\t']) {
      const result = await retry(blank, 1)
      assert.equal(result.success, false, `${name} ${JSON.stringify(blank)}`)
      assert.match(result.error ?? '', /id of the row/, name)
    }
  }
  assert.deepEqual(candidateQueries, [])
})

test('the confirmation is bound to the reviewed ROWS: a swap between read and retry is refused', async () => {
  reset()
  // Same COUNT as the review, one row replaced — a count check would have let this through.
  failedIds = ['a', 'c']
  for (const [name, retry] of await entryPoints()) {
    const result = await retry(undefined, undefined, { confirmed: true, rowIds: ['a', 'b'] } as never)
    assert.equal(result.success, false, name)
    assert.match(result.error ?? '', /changed since you reviewed/, name)
  }
  // A row that failed after the review is also a change.
  failedIds = ['a', 'b', 'c']
  const [, direct] = (await entryPoints())[1]!
  assert.equal((await direct(undefined, undefined, { confirmed: true, rowIds: ['a', 'b'] } as never)).success, false)
  assert.deepEqual(candidateQueries, [])
})

test('a matching confirmation proceeds, scoped to exactly the confirmed ids; the permission gate ran first', async () => {
  reset()
  failedIds = ['a', 'b']
  for (const [name, retry] of await entryPoints()) {
    candidateQueries.length = 0
    gates.length = 0
    const result = await retry(undefined, undefined, { confirmed: true, rowIds: ['b', 'a'] } as never)
    assert.equal(result.success, true, name)
    assert.deepEqual(gates[0], { kind: 'permission', arg: 'sync' }, name)
    assert.equal(candidateQueries.length, 1, name)
    assert.deepEqual((candidateQueries[0]!.id as { in: string[] }).in.slice().sort(), ['a', 'b'], name)
  }
})

test('with no permission every bulk entry point is refused before the confirmation is read', async () => {
  reset()
  denyAll = true
  for (const [name, retry] of await entryPoints()) {
    // The accounting wrapper lets the denial throw; the Xero action reports it as a failed result.
    const outcome = await retry(undefined, undefined, { confirmed: true, rowIds: [] } as never).then((r) => r, (e: Error) => e)
    if (outcome instanceof Error) assert.match(outcome.message, /Forbidden/, name)
    else {
      assert.equal(outcome.success, false, name)
      assert.notEqual(outcome.code, CONFIRMATION_REQUIRED_CODE, `${name}: denied on permission, not on confirmation`)
    }
  }
  assert.deepEqual(candidateQueries, [])
})

// ---------------------------------------------------------------------------------------------
// Mintsoft go-live
// ---------------------------------------------------------------------------------------------
const PAIRED_AT = new Date('2026-11-01T00:00:00Z')
const alignBinding = () => ({
  id: 'bind-1',
  connector: 'mintsoft',
  warehouseId: 'wh-1',
  externalWarehouseId: 'ext-1',
  connectionId: 'conn-1',
  pairingChangedAt: PAIRED_AT,
  stockSyncMode: 'ALIGN_TO_WMS',
  alignmentConfirmedAt: null,
  warehouse: { code: 'MIL1' },
})
function freshDryRun(over: Partial<DryRunJob> & { summary?: Record<string, unknown> } = {}): DryRunJob {
  return {
    id: 'job-1',
    startedAt: new Date('2026-11-02T00:00:00Z'),
    ...over,
    summary: { dryRun: true, externalWarehouseId: 'ext-1', connectionId: 'conn-1', ...over.summary },
  }
}

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
  dryRuns = []
  const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /dry run/)
  assert.deepEqual(bindingUpdates, [])
})

test('a concurrent re-point between approval and write refuses the confirmation: the new pairing is never armed', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  reset()
  bindingRow = alignBinding()
  betweenReadAndWrite = () => {
    // Another admin re-points the binding after the typed code and the dry run were checked.
    bindingRow = { ...bindingRow!, externalWarehouseId: 'ext-2', pairingChangedAt: new Date('2026-11-03T00:00:00Z'), alignmentConfirmedAt: null }
  }
  const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
  assert.equal(result.success, false)
  assert.equal(result.code, CONFIRMATION_REQUIRED_CODE)
  assert.match(result.error ?? '', /changed while you were confirming/)
  assert.deepEqual(bindingUpdates, [], 'nothing was written')
  assert.equal(bindingRow!.alignmentConfirmedAt, null)
  assert.deepEqual(logs, [])
})

test('dry-run evidence from before a re-point, for another external warehouse or connection, or with no connection stamp is rejected', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  const stale: Array<[string, DryRunJob]> = [
    ['started before the binding was last re-pointed', freshDryRun({ startedAt: new Date('2026-10-31T00:00:00Z') })],
    ['ran against another Mintsoft warehouse', freshDryRun({ summary: { externalWarehouseId: 'ext-OLD' } })],
    ['ran against another connection', freshDryRun({ summary: { connectionId: 'conn-OLD' } })],
    ['recorded before the connection was stamped', freshDryRun({ summary: { connectionId: undefined } })],
  ]
  for (const [name, job] of stale) {
    reset()
    bindingRow = alignBinding()
    dryRuns = [job]
    const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
    assert.equal(result.success, false, name)
    assert.match(result.error ?? '', /dry run/, name)
    assert.deepEqual(bindingUpdates, [], name)
  }
})

test('a fresh dry run for the new pairing is accepted after a re-point', async () => {
  const { confirmMintsoftAlignmentMode } = await import('@/app/actions/mintsoft-sync')
  reset()
  bindingRow = { ...alignBinding(), externalWarehouseId: 'ext-2', pairingChangedAt: new Date('2026-11-03T00:00:00Z') }
  // The old run still exists but belongs to ext-1; the new one started after the re-point.
  dryRuns = [
    freshDryRun({ id: 'old' }),
    freshDryRun({ id: 'new', startedAt: new Date('2026-11-04T00:00:00Z'), summary: { externalWarehouseId: 'ext-2' } }),
  ]
  const result = await confirmMintsoftAlignmentMode('bind-1', { confirmed: true, typedName: 'MIL1' })
  assert.deepEqual(result, { success: true })
  assert.equal(bindingUpdates.length, 1)
})
