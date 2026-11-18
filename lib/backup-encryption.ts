import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { open, rename, rm } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { parseAesEncryptionKey, resolveAesEncryptionKey } from '@/lib/security/encryption-key'

/**
 * Client-side encryption of a backup file before it leaves the machine (S3 / SFTP upload).
 *
 * KEY. Never stored with, or inside, the backup. It is taken from the process environment only:
 * `BACKUP_ENCRYPTION_KEY` (preferred: a key of its own, same accepted formats as
 * SETTINGS_ENCRYPTION_KEY) or, when that is unset, `SETTINGS_ENCRYPTION_KEY`. A per-file data key is
 * derived with HKDF-SHA256 over a random per-file salt, so one file's key never encrypts another.
 * The operator keeps the same value in their secret store (Vaultwarden): losing it makes every
 * encrypted remote copy unreadable, and nothing in IMS can recover it.
 *
 * FORMAT. magic "IMSBKENC1\n" (10) | salt (16) | iv (12) | AES-256-GCM ciphertext | tag (16).
 * Decrypting writes to a temporary file and renames it only once the tag has verified, so a
 * truncated or tampered file never leaves plaintext behind under the final name.
 */
export const BACKUP_ENCRYPTED_SUFFIX = '.enc'
export const BACKUP_ENCRYPTION_SETTING = 'backup_remote_encryption_enabled'

const MAGIC = Buffer.from('IMSBKENC1\n', 'utf8')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN
const HKDF_INFO = 'ims-backup-encryption-v1'

export function resolveBackupEncryptionKey(): Buffer | null {
  return parseAesEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY) ?? resolveAesEncryptionKey()
}

function requireKey(): Buffer {
  const key = resolveBackupEncryptionKey()
  if (!key) {
    throw new Error(
      'Backup encryption is switched on but no key is available. Set BACKUP_ENCRYPTION_KEY (or SETTINGS_ENCRYPTION_KEY) in the server environment: a 32-byte key as base64, 64-char hex, or a raw 32-byte string.',
    )
  }
  return key
}

function deriveDataKey(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, HKDF_INFO, 32))
}

export function isBackupEncryptionEnabledValue(value: string | null | undefined): boolean {
  return value === 'true'
}

export async function encryptBackupFile(srcPath: string, destPath: string, masterKey: Buffer = requireKey()): Promise<void> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveDataKey(masterKey, salt), iv)
  const out = createWriteStream(destPath, { mode: 0o600 })
  async function* body() {
    yield Buffer.concat([MAGIC, salt, iv])
    for await (const chunk of createReadStream(srcPath)) yield cipher.update(chunk as Buffer)
    yield cipher.final()
    yield cipher.getAuthTag()
  }
  try {
    await pipeline(body, out)
  } catch (error) {
    await rm(destPath, { force: true })
    throw error
  }
}

export async function decryptBackupFile(srcPath: string, destPath: string, masterKey: Buffer = requireKey()): Promise<void> {
  const fh = await open(srcPath, 'r')
  let header: Buffer
  let tag: Buffer
  let size: number
  try {
    size = (await fh.stat()).size
    if (size < HEADER_LEN + TAG_LEN) throw new Error('Not an encrypted IMS backup (file too short).')
    header = Buffer.alloc(HEADER_LEN)
    await fh.read(header, 0, HEADER_LEN, 0)
    tag = Buffer.alloc(TAG_LEN)
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN)
  } finally {
    await fh.close()
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted IMS backup (bad header).')
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN)
  const iv = header.subarray(MAGIC.length + SALT_LEN)
  const decipher = createDecipheriv('aes-256-gcm', deriveDataKey(masterKey, salt), iv)
  decipher.setAuthTag(tag)
  const tmpPath = `${destPath}.partial`
  try {
    await pipeline(
      createReadStream(srcPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      createWriteStream(tmpPath, { mode: 0o600 }),
    )
    await rename(tmpPath, destPath)
  } catch (error) {
    await rm(tmpPath, { force: true })
    throw error
  }
}
