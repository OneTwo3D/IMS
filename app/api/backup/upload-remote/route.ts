import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import { getBackupDir } from '@/lib/backup-storage'
import { BackupArtifactUploadError, uploadBackupArtifactsToTarget } from '@/lib/backup-remote'
import { backupManifestPath } from '@/lib/backup-manifest'

const BACKUP_DIR = getBackupDir()

export async function POST(req: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const { filename, target } = await req.json() as { filename: string; target: 's3' | 'sftp' }

  const safe = path.basename(filename)
  const filePath = path.join(BACKUP_DIR, safe)

  try {
    if (target !== 's3' && target !== 'sftp') {
      return NextResponse.json({ error: 'Invalid target.' }, { status: 400 })
    }
    const result = await uploadBackupArtifactsToTarget(
      filePath,
      safe,
      backupManifestPath(filePath),
      `${safe}.manifest.json`,
      target,
    )

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      description: `Uploaded backup ${safe} to ${result.backupDestination}`,
      metadata: {
        target,
        backupDestination: result.backupDestination,
        manifestDestination: result.manifestDestination,
      },
    })

    return NextResponse.json({ success: true, destination: result.backupDestination, manifestDestination: result.manifestDestination })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const metadata = e instanceof BackupArtifactUploadError
      ? e.details
      : { target, backupFilename: safe, manifestFilename: `${safe}.manifest.json` }
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      level: 'ERROR',
      description: `Failed to upload backup ${safe}: ${msg}`,
      metadata,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
