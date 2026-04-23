import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, access, unlink, stat } from 'fs/promises'
import path from 'path'
import readline from 'readline'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import { getBackupDir } from '@/lib/backup-storage'
import { disableMaintenanceMode, enableMaintenanceMode } from '@/lib/maintenance-mode'
import { sendEmail } from '@/lib/mailer'
import { consumeAuthToken, setAuthToken } from '@/lib/auth/token-store'
import { db } from '@/lib/db'

const BACKUP_DIR = getBackupDir()
const RESTORE_TOKEN_TTL_MS = 5 * 60_000
const MAX_RESTORE_FILE_BYTES = 256 * 1024 * 1024
const MAX_RESTORE_FORM_BYTES = MAX_RESTORE_FILE_BYTES + 64 * 1024

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

function getRequestOrigin(request: NextRequest): string {
  const fwdProto = (request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')).split(',')[0].trim()
  const fwdHost = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host).split(',')[0].trim()
  return `${fwdProto}://${fwdHost}`
}

function isSameOriginRequest(request: NextRequest): boolean {
  const expectedOrigin = getRequestOrigin(request)
  const origin = request.headers.get('origin')
  if (origin) return origin === expectedOrigin

  const referer = request.headers.get('referer')
  if (!referer) return false

  try {
    return new URL(referer).origin === expectedOrigin
  } catch {
    return false
  }
}

function resolveBackupPath(filename: string): string | null {
  const safe = path.basename(filename)
  const resolvedBase = path.resolve(BACKUP_DIR)
  const resolvedTarget = path.resolve(BACKUP_DIR, safe)
  if (!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`) && resolvedTarget !== resolvedBase) {
    return null
  }
  return resolvedTarget
}

function formatRestoreEmail(token: string) {
  return `
    <p>A database restore was requested for your onetwoInventory admin account.</p>
    <p>Use this confirmation code to continue:</p>
    <p style="font-size:24px;font-weight:700;letter-spacing:0.2em;"><code>${token}</code></p>
    <p>This code expires in 5 minutes and can be used only once.</p>
    <p>If you did not request this, review admin access immediately.</p>
  `
}

async function validateRestoreSqlFile(filePath: string): Promise<void> {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  let lineNumber = 0
  try {
    for await (const line of rl) {
      lineNumber++
      if (/^\s*\\/.test(line)) {
        throw new Error(`Restore file contains unsupported psql metacommand on line ${lineNumber}`)
      }
    }
  } finally {
    rl.close()
  }
}

async function runRestore(filePath: string, db: ReturnType<typeof getDbConfig>): Promise<void> {
  await validateRestoreSqlFile(filePath)

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-X',
      '-h', db.host,
      '-p', db.port,
      '-U', db.user,
      '-d', db.database,
      '--single-transaction',
      '--set', 'ON_ERROR_STOP=1',
    ]
    const child = spawn('psql', args, {
      env: { ...process.env, PGPASSWORD: db.password },
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Restore timed out'))
    }, 300000)

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
      if (stderr.length > 2000) stderr = stderr.slice(-2000)
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `psql exited with code ${code}`))
    })

    const input = createReadStream(filePath)
    input.on('error', (error) => {
      child.stdin.destroy(error)
    })
    child.stdin.on('error', () => {
      // handled by child close/error paths
    })
    input.pipe(child.stdin)
  })
}

export async function GET() {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  })
  const email = user?.email?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'Your user account does not have an email address configured.' }, { status: 400 })
  }

  const restoreToken = randomBytes(4).toString('hex').toUpperCase()
  await setAuthToken(`backup_restore:${restoreToken}`, session.user.id, RESTORE_TOKEN_TTL_MS)
  const mail = await sendEmail({
    to: email,
    subject: 'Backup restore confirmation code',
    html: formatRestoreEmail(restoreToken),
  })
  if (!mail.success) {
    return NextResponse.json({ error: mail.error ?? 'Failed to send restore confirmation email.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, email, expiresInSec: RESTORE_TOKEN_TTL_MS / 1000 })
}

export async function POST(req: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: 'Cross-site restore requests are not allowed.' }, { status: 403 })
  }

  const contentType = req.headers.get('content-type') ?? ''
  const contentLength = req.headers.get('content-length')
  if (contentType.includes('multipart/form-data')) {
    if (!contentLength) {
      return NextResponse.json({ error: 'Restore upload must include Content-Length.' }, { status: 411 })
    }
    const requestBytes = Number.parseInt(contentLength, 10)
    if (!Number.isFinite(requestBytes) || requestBytes <= 0) {
      return NextResponse.json({ error: 'Restore upload size is invalid.' }, { status: 400 })
    }
    if (requestBytes > MAX_RESTORE_FORM_BYTES) {
      return NextResponse.json({ error: 'Restore upload is too large.' }, { status: 413 })
    }
  }

  const formData = await req.formData()
  const confirm = formData.get('confirm')
  const restoreToken = formData.get('restoreToken')
  if (confirm !== 'RESTORE') {
    return NextResponse.json({ error: 'Restore confirmation missing.' }, { status: 400 })
  }
  if (typeof restoreToken !== 'string' || restoreToken.trim().length < 6) {
    return NextResponse.json({ error: 'Restore email code missing.' }, { status: 400 })
  }
  const restoreTokenUserId = await consumeAuthToken(`backup_restore:${restoreToken.trim().toUpperCase()}`)
  if (restoreTokenUserId !== session.user.id) {
    return NextResponse.json({ error: 'Restore email code invalid or expired.' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  const filename = formData.get('filename') as string | null

  const db = getDbConfig()
  let restorePath: string
  let uploadedTempFile = false

  if (file) {
    // Uploaded file
    if (!file.name.endsWith('.sql')) {
      return NextResponse.json({ error: 'Invalid file type. Only plain SQL (.sql) backups are supported. PostgreSQL custom-format .dump files require pg_restore and are not supported.' }, { status: 400 })
    }
    if (file.size > MAX_RESTORE_FILE_BYTES) {
      return NextResponse.json({ error: 'Restore file is too large.' }, { status: 413 })
    }
    await mkdir(BACKUP_DIR, { recursive: true })
    restorePath = path.join(BACKUP_DIR, `restore-upload-${Date.now()}.sql`)
    const uploadStream = file.stream() as unknown as NodeReadableStream<Uint8Array>
    await pipeline(
      Readable.fromWeb(uploadStream),
      createWriteStream(restorePath),
    )
    uploadedTempFile = true
  } else if (filename) {
    // Existing backup file
    if (!filename.endsWith('.sql')) {
      return NextResponse.json({ error: 'Invalid backup filename.' }, { status: 400 })
    }
    const resolved = resolveBackupPath(filename)
    if (!resolved) {
      return NextResponse.json({ error: 'Invalid backup filename.' }, { status: 400 })
    }
    restorePath = resolved
    try {
      await access(restorePath)
    } catch {
      return NextResponse.json({ error: 'Backup file not found.' }, { status: 404 })
    }
    const fileInfo = await stat(restorePath)
    if (fileInfo.size > MAX_RESTORE_FILE_BYTES) {
      return NextResponse.json({ error: 'Restore file is too large.' }, { status: 413 })
    }
  } else {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
  }

  const cleanup = async () => {
    if (!uploadedTempFile) return
    try {
      await unlink(restorePath)
    } catch {
      // Best-effort cleanup only.
    }
  }

  try {
    await enableMaintenanceMode(`Database restore requested by admin ${session.user.id}`)
    await runRestore(restorePath, db)
    await disableMaintenanceMode()
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_restored',
      level: 'WARNING',
      description: `Restored database from backup: ${path.basename(restorePath)}`,
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    await disableMaintenanceMode()
    const message = error instanceof Error ? error.message : String(error)
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_restored',
      level: 'ERROR',
      description: `Failed to restore backup: ${message}`,
    })
    return NextResponse.json({ error: `Restore failed: ${message.slice(0, 200)}` }, { status: 500 })
  } finally {
    await disableMaintenanceMode()
    await cleanup()
  }
}
