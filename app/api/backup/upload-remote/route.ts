import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import { getBackupDir } from '@/lib/backup-storage'
import { uploadBackupToTarget } from '@/lib/backup-remote'

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
    const result = await uploadBackupToTarget(filePath, safe, target)

    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      description: `Uploaded backup ${safe} to ${result.destination}`,
    })

    return NextResponse.json({ success: true, destination: result.destination })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      level: 'ERROR',
      description: `Failed to upload backup ${safe}: ${msg}`,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
