import { isIP } from 'node:net'
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

function ipv4Octets(host: string): number[] | null {
  if (isIP(host) !== 4) return null
  return host.split('.').map(Number)
}

function isForbiddenIpv4(o: number[]): boolean {
  if (o[0] === 127 || o[0] === 0) return true // loopback, "this host"
  if (o[0] === 169 && o[1] === 254) return true // link-local incl. cloud metadata
  if (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) return true // Alibaba metadata
  if (o[0] === 192 && o[1] === 0 && o[2] === 0 && o[3] === 192) return true // Oracle metadata
  return false
}

/** Expands an IPv6 literal to 8 16-bit groups (embedded dotted IPv4 handled), or null. */
function ipv6Groups(host: string): number[] | null {
  if (isIP(host) !== 6) return null
  let h = host.toLowerCase()
  const zone = h.indexOf('%')
  if (zone >= 0) h = h.slice(0, zone)
  const dotted = h.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const o = dotted[1].split('.').map(Number)
    h = h.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const [head, tail, extra] = h.split('::')
  if (extra !== undefined) return null
  const a = head ? head.split(':') : []
  const b = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - a.length - b.length
  if (fill < 0 || (tail === undefined && a.length !== 8)) return null
  const groups = [...a, ...Array(fill).fill('0'), ...b].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** Hosts that are never a backup server: loopback, unspecified, link-local / cloud metadata, ULA. */
function isForbiddenHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true
  const v4 = ipv4Octets(host)
  if (v4) return isForbiddenIpv4(v4)
  const g = ipv6Groups(host)
  if (g) {
    // IPv4-mapped (::ffff:a.b.c.d / ::ffff:hhhh:hhhh) and deprecated IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
    const lead0 = g.slice(0, 5).every((x) => x === 0)
    if (lead0 && (g[5] === 0xffff || g[5] === 0) && !(g[5] === 0 && g[6] === 0 && g[7] <= 1)) {
      return isForbiddenIpv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
    }
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true // :: and ::1
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local (e.g. fd00:ec2::254)
    return false
  }
  // Shorthand IPv4 forms ("2130706433", "0x7f.1", "127.1") that a resolver would still read as an address.
  if (/^[0-9a-fx.]+$/.test(host) && /[0-9]/.test(host) && !/^[a-f]+$/.test(host)) return true
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

/**
 * When the SFTP destination moves, every stored SFTP credential that was NOT re-entered in the same
 * save must be cleared: the upload prefers the private key over the password, so leaving either
 * behind would still send a stored secret to the new server.
 */
export function sftpCredentialsToClear(
  current: Record<string, string>,
  next: Record<string, string>,
): string[] {
  const changed = (k: string) => k in next && (next[k] ?? '').trim() !== (current[k] ?? '').trim()
  if (!(changed('backup_sftp_host') || changed('backup_sftp_port') || changed('backup_sftp_user'))) return []
  return ['backup_sftp_password', 'backup_sftp_private_key'].filter((k) => current[k] && !next[k])
}
