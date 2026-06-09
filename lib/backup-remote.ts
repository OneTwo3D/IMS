import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import path from 'path'
import { getSettingValues } from '@/lib/settings-store'

export type BackupUploadTarget = 's3' | 'sftp'

export async function uploadBackupToTarget(
  filePath: string,
  filename: string,
  target: BackupUploadTarget,
  contentType = 'application/sql',
) {
  if (target === 's3') return uploadToS3(filePath, filename, contentType)
  return uploadToSftp(filePath, filename)
}

export async function deleteBackupFromTarget(filename: string, target: BackupUploadTarget): Promise<void> {
  if (target === 's3') {
    await deleteFromS3(filename)
    return
  }
  await deleteFromSftp(filename)
}

export type BackupArtifactUploadResult = {
  backupDestination: string
  manifestDestination: string
  orphanCleanupAttempted: boolean
  orphanCleanupSucceeded: boolean | null
}

export type BackupArtifactTransferOps = {
  upload: typeof uploadBackupToTarget
  remove: typeof deleteBackupFromTarget
}

export async function uploadBackupArtifactsToTarget(
  backupFilePath: string,
  backupFilename: string,
  manifestFilePath: string,
  manifestFilename: string,
  target: BackupUploadTarget,
  ops: BackupArtifactTransferOps = {
    upload: uploadBackupToTarget,
    remove: deleteBackupFromTarget,
  },
): Promise<BackupArtifactUploadResult> {
  const backupResult = await ops.upload(backupFilePath, backupFilename, target)
  try {
    const manifestResult = await ops.upload(manifestFilePath, manifestFilename, target, 'application/json')
    return {
      backupDestination: backupResult.destination,
      manifestDestination: manifestResult.destination,
      orphanCleanupAttempted: false,
      orphanCleanupSucceeded: null,
    }
  } catch (error) {
    let cleanupSucceeded = false
    try {
      await ops.remove(backupFilename, target)
      cleanupSucceeded = true
    } catch {
      cleanupSucceeded = false
    }
    throw new BackupArtifactUploadError(
      `Backup manifest upload failed after SQL upload: ${error instanceof Error ? error.message : String(error)}`,
      {
        target,
        backupFilename,
        manifestFilename,
        backupDestination: backupResult.destination,
        orphanCleanupAttempted: true,
        orphanCleanupSucceeded: cleanupSucceeded,
      },
    )
  }
}

export class BackupArtifactUploadError extends Error {
  constructor(
    message: string,
    public readonly details: {
      target: BackupUploadTarget
      backupFilename: string
      manifestFilename: string
      backupDestination: string
      orphanCleanupAttempted: boolean
      orphanCleanupSucceeded: boolean
    },
  ) {
    super(message)
    this.name = 'BackupArtifactUploadError'
  }
}

async function uploadToS3(filePath: string, filename: string, contentType: string) {
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
    ContentType: contentType,
  }))

  return { destination: `s3://${bucket}/${key}` }
}

async function deleteFromS3(filename: string): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
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
  const key = prefix ? `${prefix.replace(/\/$/, '')}/${filename}` : filename
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
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

async function deleteFromSftp(filename: string): Promise<void> {
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
  try {
    await sftp.delete(remote)
  } finally {
    await sftp.end()
  }
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
