import { BACKUP_ENCRYPTION_SETTING } from '@/lib/backup-encryption'

/**
 * Backup target settings (S3 endpoint / SFTP server) are where the database dump is SENT, and the
 * stored credential is sent with it. They are written only through `saveBackupTargetSettings`
 * (fresh-auth gated) and are deliberately NOT on the generic settings allowlist.
 */
export const BACKUP_TARGET_SETTING_KEYS: readonly string[] = [
  'backup_s3_endpoint',
  'backup_s3_region',
  'backup_s3_bucket',
  'backup_s3_access_key',
  'backup_s3_secret_key',
  'backup_s3_prefix',
  'backup_sftp_host',
  'backup_sftp_port',
  'backup_sftp_user',
  'backup_sftp_password',
  'backup_sftp_private_key',
  'backup_sftp_host_fingerprint',
  'backup_sftp_path',
  BACKUP_ENCRYPTION_SETTING,
]

/** Hosts that are never a backup server: loopback, unspecified, link-local / cloud metadata. */
function isForbiddenHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true
  if (/^127\./.test(host) || host === '0.0.0.0' || /^169\.254\./.test(host)) return true
  if (host === '::1' || host === '::' || /^fe80:/.test(host) || /^::ffff:(127\.|169\.254\.)/.test(host)) return true
  return false
}

/** Returns an operator-facing error, or null when the values are acceptable. */
export function validateBackupTargetValues(values: Record<string, string>): string | null {
  const endpoint = values.backup_s3_endpoint?.trim()
  if (endpoint) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      return 'The S3 endpoint is not a valid URL.'
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The S3 endpoint must be an http(s) URL.'
    if (url.username || url.password) return 'The S3 endpoint must not contain credentials.'
    if (isForbiddenHost(url.hostname)) return 'The S3 endpoint host is not allowed (loopback, link-local and metadata addresses are refused).'
  }
  const host = values.backup_sftp_host?.trim()
  if (host) {
    if (/[\s/@]/.test(host)) return 'The SFTP host must be a bare hostname or IP address.'
    if (isForbiddenHost(host)) return 'The SFTP host is not allowed (loopback, link-local and metadata addresses are refused).'
  }
  const port = values.backup_sftp_port?.trim()
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return 'The SFTP port must be 1-65535.'
  const enc = values[BACKUP_ENCRYPTION_SETTING]
  if (enc !== undefined && enc !== 'true' && enc !== 'false') return 'Invalid encryption setting.'
  return null
}

/**
 * A stored credential must not follow a changed destination. If the S3 endpoint/bucket or the SFTP
 * host/port/user moves, the secret has to be supplied again in the same save; otherwise the stored
 * secret would be sent to the new host.
 */
export function credentialsFollowChangedTarget(
  current: Record<string, string>,
  next: Record<string, string>,
): string | null {
  const changed = (k: string) => k in next && (next[k] ?? '').trim() !== (current[k] ?? '').trim()
  const s3Moved = changed('backup_s3_endpoint') || changed('backup_s3_bucket')
  if (s3Moved && current.backup_s3_secret_key && !next.backup_s3_secret_key) {
    return 'Re-enter the S3 secret key when changing the endpoint or bucket, so the stored key is not sent to a new destination.'
  }
  const sftpMoved = changed('backup_sftp_host') || changed('backup_sftp_port') || changed('backup_sftp_user')
  if (
    sftpMoved &&
    (current.backup_sftp_password || current.backup_sftp_private_key) &&
    !next.backup_sftp_password &&
    !next.backup_sftp_private_key
  ) {
    return 'Re-enter the SFTP password or private key when changing the host, port or user, so the stored credential is not sent to a new server.'
  }
  return null
}
