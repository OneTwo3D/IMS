import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { mkdir, readdir, stat, unlink } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getBackupDir } from '@/lib/backup-storage'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { BackupArtifactUploadError, uploadBackupArtifactsToTarget } from '@/lib/backup-remote'
import { appendCronRunId, cronRunResponseInit, runCronWithLogging } from '@/lib/ops/cron-run'
import { backupManifestPath, writeBackupManifestForFile } from '@/lib/backup-manifest'

const BACKUP_DIR = getBackupDir()

async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? ''
}

function getDbConfig() {
  const url = new URL(process.env.DATABASE_URL!)
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: url.username,
    password: url.password,
    database: url.pathname.slice(1),
  }
}

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('backup')
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, responseStatus } = await runCronWithLogging({
    jobName: 'backup',
    run: async () => {
      const enabled = await getSetting('backup_schedule_enabled')
      if (enabled !== 'true') {
        return { skipped: true, reason: 'Scheduled backups disabled' }
      }

      const retentionDays = parseInt(await getSetting('backup_retention_days') || '30')
      const maxBackups = parseInt(await getSetting('backup_max_count') || '10')

      const dbConf = getDbConfig()
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const filename = `scheduled-${ts}.sql`
      const filePath = path.join(BACKUP_DIR, filename)

      await mkdir(BACKUP_DIR, { recursive: true })

      // Create backup (using execFile to prevent command injection)
      const created = await new Promise<boolean>((resolve) => {
        const args = ['-h', dbConf.host, '-p', dbConf.port, '-U', dbConf.user, '-d', dbConf.database, '--no-owner', '--no-acl', '-F', 'p', '-f', filePath]
        execFile('pg_dump', args, { timeout: 120000, env: { ...process.env, PGPASSWORD: dbConf.password } }, async (error) => {
          if (error) {
            await logActivity({ entityType: 'SYSTEM', tag: 'system', action: 'scheduled_backup', level: 'ERROR', description: `Scheduled backup failed: ${error.message}` })
            resolve(false)
          } else {
            resolve(true)
          }
        })
      })

      if (!created) return { error: 'Backup creation failed' }

      try {
        await writeBackupManifestForFile(filePath, filename, db)
      } catch (error) {
        await logActivity({
          entityType: 'SYSTEM',
          tag: 'system',
          action: 'scheduled_backup',
          level: 'ERROR',
          description: `Scheduled backup manifest failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        return { error: 'Backup manifest creation failed' }
      }

      // Upload to remote if configured
      const autoUploadTarget = await getSetting('backup_auto_upload')
      let uploaded = false
      if (autoUploadTarget === 's3' || autoUploadTarget === 'sftp') {
        try {
          await uploadBackupArtifactsToTarget(
            filePath,
            filename,
            backupManifestPath(filePath),
            `${filename}.manifest.json`,
            autoUploadTarget,
          )
          uploaded = true
        } catch (error) {
          const metadata = error instanceof BackupArtifactUploadError
            ? error.details
            : { target: autoUploadTarget, backupFilename: filename, manifestFilename: `${filename}.manifest.json` }
          await logActivity({
            entityType: 'SYSTEM',
            tag: 'system',
            action: 'scheduled_backup',
            level: 'WARNING',
            description: `Scheduled backup created but remote upload to ${autoUploadTarget} failed: ${String(error)}`,
            metadata,
          })
        }
      }

      // Cleanup: remove old backups beyond retention
      let deleted = 0
      try {
        const files = await readdir(BACKUP_DIR)
        const backups: { name: string; mtime: Date }[] = []
        for (const f of files) {
          if (!f.endsWith('.sql') && !f.endsWith('.dump')) continue
          const s = await stat(path.join(BACKUP_DIR, f))
          backups.push({ name: f, mtime: s.mtime })
        }
        backups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

        for (let i = 0; i < backups.length; i++) {
          const shouldDelete = i >= maxBackups || backups[i].mtime.getTime() < cutoff
          if (shouldDelete) {
            await unlink(path.join(BACKUP_DIR, backups[i].name))
            deleted++
          }
        }
      } catch { /* ignore cleanup errors */ }

      await logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'scheduled_backup',
        description: `Scheduled backup ${filename} created${uploaded ? ` and uploaded to ${autoUploadTarget}` : ''}${deleted > 0 ? `, ${deleted} old backup(s) purged` : ''}`,
      })

      return { filename, uploaded, deleted }
    },
    getOutcome: (result) => ({
      responseStatus: 'error' in result ? 500 : 200,
    }),
  })

  return NextResponse.json(appendCronRunId(result, runId), cronRunResponseInit({ status: responseStatus }))
}
