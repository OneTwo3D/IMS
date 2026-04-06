import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { mkdir, readFile } from 'fs/promises'
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

export async function POST() {
  const session = await auth()
  if (!session?.user?.id || (session.user as { role?: string }).role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const db = getDbConfig()
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `backup-${ts}.sql`
  const filePath = path.join(BACKUP_DIR, filename)

  await mkdir(BACKUP_DIR, { recursive: true })

  return new Promise<NextResponse>((resolve) => {
    const args = ['-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, '--no-owner', '--no-acl', '-F', 'p', '-f', filePath]
    execFile('pg_dump', args, { timeout: 120000, env: { ...process.env, PGPASSWORD: db.password } }, async (error) => {
      if (error) {
        logActivity({
          entityType: 'SYSTEM',
          tag: 'system',
          action: 'backup_created',
          level: 'ERROR',
          description: `Failed to create backup: ${error.message}`,
        })
        resolve(NextResponse.json({ error: 'Backup failed.' }, { status: 500 }))
        return
      }

      logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'backup_created',
        description: `Created backup: ${filename}`,
      })

      try {
        const buffer = await readFile(filePath)
        resolve(
          new NextResponse(buffer, {
            headers: {
              'Content-Type': 'application/sql',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Cache-Control': 'no-store',
            },
          }),
        )
      } catch {
        resolve(NextResponse.json({ error: 'Failed to read backup file.' }, { status: 500 }))
      }
    })
  })
}
