import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * FAILURES A ROUTE CATCHES MUST REACH THE RESULT. The backup route kept going after a failed remote upload, and the accounting-sync route
 * kept running its independent sweeps after one threw; both now carry the failure into the result so the exit status reads it.
 */

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/d'
process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

const state = {
  uploadTarget: '' as string,
  uploadRejects: false,
  repairThrows: false,
  reenqueueThrows: false,
  provisionalThrows: false,
  readdirThrows: false,
  connected: true,
}
const recorded: string[] = []

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/accounting', { namedExports: { isAccountingConnectorConnected: async () => state.connected } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          if (where.key === 'backup_auto_upload') return { value: state.uploadTarget }
          if (where.key === 'xero_sync_enabled') return { value: 'true' }
          return null
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        cronRun: { create: async (args: { data: { status: string } }) => { recorded.push(args.data.status) } },
        activityLog: { create: async () => ({}) },
      }),
    },
  },
})

// backup
mock.module('child_process', { namedExports: { execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (error: Error | null) => void) => { cb(null) } } })
mock.module('fs/promises', {
  namedExports: {
    mkdir: async () => undefined,
    readdir: async () => { if (state.readdirThrows) throw new Error('EACCES'); return [] },
    stat: async () => ({ mtime: new Date() }),
    unlink: async () => undefined,
  },
})
mock.module('@/lib/backup-storage', { namedExports: { getBackupDir: () => '/tmp/backup-test' } })
mock.module('@/lib/backup-manifest', { namedExports: { backupManifestPath: (p: string) => `${p}.manifest.json`, writeBackupManifestForFile: async () => undefined } })
class BackupArtifactUploadError extends Error { details = { target: 's3' } }
mock.module('@/lib/backup-remote', {
  namedExports: {
    BackupArtifactUploadError,
    uploadBackupArtifactsToTarget: async () => { if (state.uploadRejects) throw new BackupArtifactUploadError('bucket refused'); return undefined },
  },
})
mock.module('@/lib/domain/settings/backup-schedule-enabled', { namedExports: { isBackupScheduleEnabled: async () => true } })

// accounting-sync
mock.module('@/lib/connectors/xero/sync-processor', {
  namedExports: {
    processPendingXeroSync: async () => ({ processed: 1, succeeded: 1, failed: 0, skipped: 0 }),
    repairXeroBackReferences: async () => { if (state.repairThrows) throw new Error('repair exploded'); return { repaired: 0 } },
    reenqueueMissingCreditNoteAllocations: async () => { if (state.reenqueueThrows) throw new Error('re-enqueue exploded'); return { enqueued: 0 } },
  },
})
mock.module('@/lib/domain/purchasing/landed-cost-journal-outbox', { namedExports: { processLandedCostJournalOutbox: async () => ({ claimed: 0 }) } })
mock.module('@/lib/domain/accounting/posting-refusal-reconcile', {
  namedExports: { reconcileProvisionalPostingRefusals: async () => { if (state.provisionalThrows) throw new Error('reconcile exploded'); return { replayed: 0 } } },
})

const request = (): Request => new Request('http://localhost/api/cron/x')

test('backup: a configured remote target whose upload rejects answers 500 and is recorded failed; local-only stays 200', async () => {
  const { GET } = await import('@/app/api/cron/backup/route')
  state.uploadTarget = ''
  assert.equal((await GET(request())).status, 200)
  assert.equal(recorded.at(-1), 'completed')

  state.uploadTarget = 's3'
  state.uploadRejects = false
  assert.equal((await GET(request())).status, 200)

  state.uploadRejects = true
  const response = await GET(request())
  assert.equal(response.status, 500)
  assert.equal(recorded.at(-1), 'failed')
  const body = await response.json() as { uploaded: boolean; uploadError?: string }
  assert.equal(body.uploaded, false)
  assert.equal(body.uploadError, 'Remote upload to s3 failed')

  // a failed retention purge is a failure too, reported and not dropped
  state.uploadRejects = false
  state.readdirThrows = true
  assert.equal((await GET(request())).status, 500)
  state.readdirThrows = false
})

test('accounting-sync: a healthy drain with a throwing sweep answers 500; every sweep failure is carried in errors', async () => {
  const { GET } = await import('@/app/api/cron/accounting-sync/route')
  assert.equal((await GET(request())).status, 200)

  for (const key of ['repairThrows', 'reenqueueThrows', 'provisionalThrows'] as const) {
    state[key] = true
    const response = await GET(request())
    assert.equal(response.status, 500, key)
    const body = await response.json() as { errors?: string[]; processed: number }
    assert.equal(body.processed, 1, 'the main drain result is still returned')
    assert.equal(body.errors?.length, 1, key)
    state[key] = false
  }
})

test('accounting-sync: a sweep failure on a tick that skipped by design still answers 500', async () => {
  const { GET } = await import('@/app/api/cron/accounting-sync/route')
  state.provisionalThrows = true
  state.connected = false
  assert.equal((await GET(request())).status, 500)
  state.provisionalThrows = false
  assert.equal((await GET(request())).status, 200)
  state.connected = true
})
