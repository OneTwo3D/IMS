import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// A failed remote upload must not let local retention delete older local copies: they may be the
// only copies left.

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/d'
process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

const state = { uploadRejects: false, unlinked: [] as string[], logs: [] as string[] }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: { description: string }) => { state.logs.push(e.description) } } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          if (where.key === 'backup_auto_upload') return { value: 's3' }
          if (where.key === 'backup_max_count') return { value: '1' }
          return null
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        cronRun: { create: async () => undefined },
        activityLog: { create: async () => ({}) },
      }),
    },
  },
})
mock.module('child_process', { namedExports: { execFile: (_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => { cb(null) } } })
mock.module('fs/promises', {
  namedExports: {
    mkdir: async () => undefined,
    readdir: async () => ['old-1.sql', 'old-2.sql', 'old-3.sql'],
    stat: async (p: string) => ({ mtime: new Date(Date.now() - Number(/old-(\d)/.exec(p)?.[1] ?? 0) * 1000) }),
    unlink: async (p: string) => { state.unlinked.push(p) },
  },
})
mock.module('@/lib/backup-storage', { namedExports: { getBackupDir: () => '/tmp/backup-test' } })
mock.module('@/lib/backup-manifest', { namedExports: { backupManifestPath: (p: string) => `${p}.manifest.json`, writeBackupManifestForFile: async () => undefined } })
class BackupArtifactUploadError extends Error { details = { target: 's3' } }
mock.module('@/lib/backup-remote', {
  namedExports: {
    BackupArtifactUploadError,
    uploadBackupArtifactsToTarget: async () => { if (state.uploadRejects) throw new Error('no usable encryption key'); return undefined },
  },
})
mock.module('@/lib/domain/settings/backup-schedule-enabled', { namedExports: { isBackupScheduleEnabled: async () => true } })

test('retention deletes old local copies after a successful upload, and keeps them all after a failed one', async () => {
  const { GET } = await import('@/app/api/cron/backup/route')
  const req = () => new Request('http://localhost/api/cron/backup')

  state.uploadRejects = false
  await GET(req())
  assert.ok(state.unlinked.length > 0, 'non-vacuous: retention prunes when the upload succeeded')

  state.uploadRejects = true
  state.unlinked = []
  state.logs = []
  const res = await GET(req())
  assert.equal(res.status, 500)
  assert.deepEqual(state.unlinked, [])
  assert.ok(state.logs.some((l) => /retention skipped/.test(l)))
})
