import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

const BACKUP_DIR = path.join(process.cwd(), 'backups')

async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? ''
}

async function uploadToS3(filePath: string, filename: string) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const [endpoint, region, bucket, accessKey, secretKey, prefix] = await Promise.all([
    getSetting('backup_s3_endpoint'),
    getSetting('backup_s3_region'),
    getSetting('backup_s3_bucket'),
    getSetting('backup_s3_access_key'),
    getSetting('backup_s3_secret_key'),
    getSetting('backup_s3_prefix'),
  ])

  if (!bucket || !accessKey || !secretKey) throw new Error('S3 not configured. Set bucket, access key, and secret key in settings.')

  const client = new S3Client({
    region: region || 'us-east-1',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })

  const buffer = await readFile(filePath)
  const key = prefix ? `${prefix.replace(/\/$/, '')}/${filename}` : filename

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/sql',
  }))

  return { destination: `s3://${bucket}/${key}` }
}

async function uploadToSftp(filePath: string, filename: string) {
  const SftpClient = (await import('ssh2-sftp-client')).default
  const [host, port, user, password, privateKey, remotePath] = await Promise.all([
    getSetting('backup_sftp_host'),
    getSetting('backup_sftp_port'),
    getSetting('backup_sftp_user'),
    getSetting('backup_sftp_password'),
    getSetting('backup_sftp_private_key'),
    getSetting('backup_sftp_path'),
  ])

  if (!host || !user) throw new Error('SFTP not configured. Set host and user in settings.')
  if (!password && !privateKey) throw new Error('SFTP requires either a password or private key.')

  const sftp = new SftpClient()
  const connectOpts: Record<string, unknown> = {
    host,
    port: parseInt(port || '22'),
    username: user,
  }

  if (privateKey) {
    connectOpts.privateKey = privateKey
  } else {
    connectOpts.password = password
  }

  await sftp.connect(connectOpts)

  const remote = remotePath ? `${remotePath.replace(/\/$/, '')}/${filename}` : `/backups/${filename}`

  // Ensure remote directory exists
  const remoteDir = path.posix.dirname(remote)
  try { await sftp.mkdir(remoteDir, true) } catch { /* may already exist */ }

  await sftp.put(filePath, remote)
  await sftp.end()

  return { destination: `sftp://${host}:${remote}` }
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || (session.user as { role?: string }).role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { filename, target } = await req.json() as { filename: string; target: 's3' | 'sftp' }

  const safe = path.basename(filename)
  const filePath = path.join(BACKUP_DIR, safe)

  try {
    let result: { destination: string }
    if (target === 's3') {
      result = await uploadToS3(filePath, safe)
    } else if (target === 'sftp') {
      result = await uploadToSftp(filePath, safe)
    } else {
      return NextResponse.json({ error: 'Invalid target.' }, { status: 400 })
    }

    logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      description: `Uploaded backup ${safe} to ${result.destination}`,
    })

    return NextResponse.json({ success: true, destination: result.destination })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logActivity({
      entityType: 'SYSTEM',
      tag: 'system',
      action: 'backup_uploaded',
      level: 'ERROR',
      description: `Failed to upload backup ${safe}: ${msg}`,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
