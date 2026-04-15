import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import path from 'path'
import { getSettingValues } from '@/lib/settings-store'

export async function uploadBackupToTarget(filePath: string, filename: string, target: 's3' | 'sftp') {
  if (target === 's3') return uploadToS3(filePath, filename)
  return uploadToSftp(filePath, filename)
}

async function uploadToS3(filePath: string, filename: string) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const settings = await getSettingValues([
    'backup_s3_endpoint',
    'backup_s3_region',
    'backup_s3_bucket',
    'backup_s3_access_key',
    'backup_s3_secret_key',
    'backup_s3_prefix',
  ])

  const endpoint = settings.get('backup_s3_endpoint') ?? ''
  const region = settings.get('backup_s3_region') ?? ''
  const bucket = settings.get('backup_s3_bucket') ?? ''
  const accessKey = settings.get('backup_s3_access_key') ?? ''
  const secretKey = settings.get('backup_s3_secret_key') ?? ''
  const prefix = settings.get('backup_s3_prefix') ?? ''

  if (!bucket || !accessKey || !secretKey) {
    throw new Error('S3 not configured. Set bucket, access key, and secret key in settings.')
  }

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
  const settings = await getSettingValues([
    'backup_sftp_host',
    'backup_sftp_port',
    'backup_sftp_user',
    'backup_sftp_password',
    'backup_sftp_private_key',
    'backup_sftp_host_fingerprint',
    'backup_sftp_path',
  ])

  const host = settings.get('backup_sftp_host') ?? ''
  const port = settings.get('backup_sftp_port') ?? ''
  const user = settings.get('backup_sftp_user') ?? ''
  const password = settings.get('backup_sftp_password') ?? ''
  const privateKey = settings.get('backup_sftp_private_key') ?? ''
  const expectedFingerprint = settings.get('backup_sftp_host_fingerprint') ?? ''
  const remotePath = settings.get('backup_sftp_path') ?? ''

  if (!host || !user) throw new Error('SFTP not configured. Set host and user in settings.')
  if (!password && !privateKey) throw new Error('SFTP requires either a password or private key.')
  if (!expectedFingerprint) {
    throw new Error('SFTP host fingerprint not configured. Set the expected host fingerprint in backup settings before uploading.')
  }

  const sftp = new SftpClient()
  const connectOpts: Record<string, unknown> = {
    host,
    hostVerifier: (key: Buffer | string) => verifySftpHostFingerprint(key, expectedFingerprint),
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
  const remoteDir = path.posix.dirname(remote)
  try {
    await sftp.mkdir(remoteDir, true)
  } catch {
    // Directory may already exist.
  }

  await sftp.put(filePath, remote)
  await sftp.end()

  return { destination: `sftp://${host}:${remote}` }
}

function verifySftpHostFingerprint(key: Buffer | string, expectedFingerprint: string): boolean {
  const normalizedExpected = normalizeFingerprint(expectedFingerprint)
  if (!normalizedExpected) return false

  const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex')
  const actualSha256 = normalizeFingerprint(`SHA256:${createHash('sha256').update(keyBuffer).digest('base64')}`)
  const actualMd5 = normalizeFingerprint(createHash('md5').update(keyBuffer).digest('hex'))

  return normalizedExpected === actualSha256 || normalizedExpected === actualMd5
}

function normalizeFingerprint(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (/^sha256:/i.test(trimmed)) {
    return `SHA256:${trimmed.slice('sha256:'.length).replace(/\s+/g, '')}`
  }

  const compactMd5 = trimmed.replace(/:/g, '').replace(/\s+/g, '').toLowerCase()
  if (/^[a-f0-9]{32}$/.test(compactMd5)) {
    return compactMd5
  }

  return trimmed.replace(/\s+/g, '')
}
