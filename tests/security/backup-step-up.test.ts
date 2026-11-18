import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextResponse } from 'next/server'

// o3d-hqvrp.5 / .6: a plain (stale) admin session must not be able to dump the database, upload it
// remotely, or repoint the backup target.

const state = { pgDumpRuns: 0, uploads: 0, writes: 0, fresh: false }

const staleResponse = () => NextResponse.json({ error: 'Re-authentication required', code: 'fresh_auth_required' }, { status: 403 })
const adminSession = { user: { id: 'u1', role: 'ADMIN' } }

mock.module('@/lib/auth/server', {
  namedExports: {
    requireApiAdmin: async () => adminSession,
    requireApiFreshAdmin: async () => (state.fresh ? adminSession : staleResponse()),
    requireFreshPermission: async () => {
      if (!state.fresh) {
        const { FreshAuthRequiredError } = await import('../../lib/auth/session-gates.ts')
        throw new FreshAuthRequiredError({ valid: false, reason: 'stale' } as never)
      }
      return adminSession
    },
    freshAuthFailureResult: (e: unknown) =>
      (e as { code?: string })?.code === 'fresh_auth_required'
        ? { success: false, error: 'Re-authentication required', code: 'fresh_auth_required' }
        : null,
    requireAdmin: async () => adminSession,
    requireFreshAdmin: async () => adminSession,
  },
})
mock.module('child_process', {
  namedExports: { execFile: () => { state.pgDumpRuns += 1 } },
})
mock.module('@/lib/backup-remote', {
  namedExports: {
    BackupArtifactUploadError: class extends Error {},
    uploadBackupArtifactsToTarget: async () => {
      state.uploads += 1
      return { backupDestination: 'x', manifestDestination: 'y' }
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/backup-manifest', {
  namedExports: { writeBackupManifestForFile: async () => {}, backupManifestPath: (p: string) => `${p}.manifest.json` },
})
mock.module('@/lib/backup-storage', { namedExports: { getBackupDir: () => '/scratch/ram/tmp/backup-step-up-test' } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ setting: { upsert: async () => { state.writes += 1 } } }),
    },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async () => new Map<string, string>(),
    serializeSettingValue: (_k: string, v: string) => v,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/x'

test('POST /api/backup/create refuses a stale admin session and never runs pg_dump', async () => {
  const { POST } = await import('../../app/api/backup/create/route.ts')
  state.fresh = false
  state.pgDumpRuns = 0
  const res = await POST()
  assert.equal(res.status, 403)
  assert.equal(state.pgDumpRuns, 0)
  assert.equal((await res.json()).code, 'fresh_auth_required')
})

test('POST /api/backup/upload-remote refuses a stale admin session and uploads nothing', async () => {
  const { POST } = await import('../../app/api/backup/upload-remote/route.ts')
  state.fresh = false
  state.uploads = 0
  const res = await POST(new Request('http://x/api/backup/upload-remote', {
    method: 'POST',
    body: JSON.stringify({ filename: 'backup.sql', target: 's3' }),
  }) as never)
  assert.equal(res.status, 403)
  assert.equal(state.uploads, 0)
})

test('POST /api/backup/upload-remote proceeds with a fresh session', async () => {
  const { POST } = await import('../../app/api/backup/upload-remote/route.ts')
  state.fresh = true
  state.uploads = 0
  const res = await POST(new Request('http://x/api/backup/upload-remote', {
    method: 'POST',
    body: JSON.stringify({ filename: 'backup.sql', target: 's3' }),
  }) as never)
  assert.equal(res.status, 200)
  assert.equal(state.uploads, 1)
})

test('saveBackupTargetSettings returns fresh_auth_required for a stale session and writes nothing', async () => {
  const { saveBackupTargetSettings } = await import('../../app/actions/backup.ts')
  state.fresh = false
  state.writes = 0
  const result = await saveBackupTargetSettings({ backup_sftp_host: 'evil.example.com' })
  assert.equal(result.success, false)
  assert.equal(result.code, 'fresh_auth_required')
  assert.equal(state.writes, 0)
})

test('saveBackupTargetSettings saves with a fresh session, refuses foreign keys and bad hosts', async () => {
  const { saveBackupTargetSettings } = await import('../../app/actions/backup.ts')
  state.fresh = true
  state.writes = 0
  assert.equal((await saveBackupTargetSettings({ backup_sftp_host: 'backup.example.com' })).success, true)
  assert.equal(state.writes, 1)
  assert.equal((await saveBackupTargetSettings({ wc_url: 'https://x' })).success, false)
  assert.equal((await saveBackupTargetSettings({ backup_s3_endpoint: 'http://169.254.169.254/' })).success, false)
  assert.equal((await saveBackupTargetSettings({ backup_sftp_host: 'localhost' })).success, false)
  assert.equal(state.writes, 1)
})
