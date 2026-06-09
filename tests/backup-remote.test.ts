import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BackupArtifactUploadError,
  uploadBackupArtifactsToTarget,
  type BackupArtifactTransferOps,
} from '../lib/backup-remote.ts'

test('uploadBackupArtifactsToTarget cleans up uploaded SQL when manifest upload fails', async () => {
  const calls: string[] = []
  const ops: BackupArtifactTransferOps = {
    async upload(_filePath, filename, _target, contentType) {
      calls.push(`upload:${filename}:${contentType ?? 'application/sql'}`)
      if (filename.endsWith('.manifest.json')) {
        throw new Error('manifest upload failed')
      }
      return { destination: `s3://bucket/${filename}` }
    },
    async remove(filename, target) {
      calls.push(`remove:${target}:${filename}`)
    },
  }

  await assert.rejects(
    uploadBackupArtifactsToTarget(
      '/tmp/backup.sql',
      'backup.sql',
      '/tmp/backup.sql.manifest.json',
      'backup.sql.manifest.json',
      's3',
      ops,
    ),
    (error: unknown) => {
      assert.equal(error instanceof BackupArtifactUploadError, true)
      assert.deepEqual((error as BackupArtifactUploadError).details, {
        target: 's3',
        backupFilename: 'backup.sql',
        manifestFilename: 'backup.sql.manifest.json',
        backupDestination: 's3://bucket/backup.sql',
        orphanCleanupAttempted: true,
        orphanCleanupSucceeded: true,
      })
      return true
    },
  )

  assert.deepEqual(calls, [
    'upload:backup.sql:application/sql',
    'upload:backup.sql.manifest.json:application/json',
    'remove:s3:backup.sql',
  ])
})
