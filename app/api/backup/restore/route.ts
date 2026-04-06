import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { auth } from '@/lib/auth'
import { logActivity } from '@/lib/activity-log'

const BACKUP_DIR = path.join(process.cwd(), 'backups')

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

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || (session.user as { role?: string }).role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const filename = formData.get('filename') as string | null

  const db = getDbConfig()
  let restorePath: string

  if (file) {
    // Uploaded file
    if (!file.name.endsWith('.sql') && !file.name.endsWith('.dump')) {
      return NextResponse.json({ error: 'Invalid file type. Use .sql or .dump files.' }, { status: 400 })
    }
    await mkdir(BACKUP_DIR, { recursive: true })
    restorePath = path.join(BACKUP_DIR, `restore-upload-${Date.now()}.sql`)
    const buffer = Buffer.from(await file.arrayBuffer())
    await writeFile(restorePath, buffer)
  } else if (filename) {
    // Existing backup file
    const safe = path.basename(filename)
    restorePath = path.join(BACKUP_DIR, safe)
  } else {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
  }

  return new Promise<NextResponse>((resolve) => {
    const args = ['-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, '-f', restorePath, '--single-transaction']
    execFile('psql', args, { timeout: 300000, env: { ...process.env, PGPASSWORD: db.password } }, (error, _stdout, stderr) => {
      if (error) {
        logActivity({
          entityType: 'SYSTEM',
          tag: 'system',
          action: 'backup_restored',
          level: 'ERROR',
          description: `Failed to restore backup: ${error.message}`,
        })
        resolve(NextResponse.json({ error: `Restore failed: ${stderr?.slice(0, 200) || error.message}` }, { status: 500 }))
        return
      }

      logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_restored',
        level: 'WARNING',
        description: `Restored database from backup: ${path.basename(restorePath)}`,
      })

      resolve(NextResponse.json({ success: true }))
    })
  })
}
