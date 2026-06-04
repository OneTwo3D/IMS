import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { decryptSecret, isEncryptedValue as isLegacyEncryptedValue } from '@/lib/secrets'

// Setting-table ciphertext format. OAuth, TOTP, and other non-Setting secrets
// still use the legacy secret helpers until their storage paths are migrated.
const ENCRYPTED_SETTING_PREFIX = 'enc:setting:v1:'
const DRAFT_ENCRYPTED_SETTING_PREFIX = 'enc:v2:'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function resolveSettingsEncryptionKey(): Buffer | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY
  if (!raw) return null

  const trimmed = raw.trim()

  try {
    const base64 = Buffer.from(trimmed, 'base64')
    if (base64.length === 32) return base64
  } catch {
    // Ignore invalid base64 and fall through to raw handling.
  }

  const utf8 = Buffer.from(trimmed, 'utf8')
  if (utf8.length === 32) return utf8

  return null
}

function aadForSetting(key: string): Buffer {
  return Buffer.from(`setting:${key}`, 'utf8')
}

export function hasSettingsEncryptionKey(): boolean {
  return resolveSettingsEncryptionKey() !== null
}

export function isEncryptedSettingValue(value: string | null | undefined): value is string {
  return !!value && (
    value.startsWith(ENCRYPTED_SETTING_PREFIX)
    || value.startsWith(DRAFT_ENCRYPTED_SETTING_PREFIX)
    || isLegacyEncryptedValue(value)
  )
}

export function isCurrentEncryptedSettingValue(value: string | null | undefined): value is string {
  return !!value && value.startsWith(ENCRYPTED_SETTING_PREFIX)
}

export function encryptSettingValue(key: string, plaintext: string): string {
  const encryptionKey = resolveSettingsEncryptionKey()
  if (!encryptionKey) {
    throw new Error('SETTINGS_ENCRYPTION_KEY is required to store encrypted settings')
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(aadForSetting(key))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${ENCRYPTED_SETTING_PREFIX}${Buffer.concat([iv, authTag, ciphertext]).toString('base64')}`
}

export function decryptSettingValue(key: string, value: string): string {
  const prefix = value.startsWith(ENCRYPTED_SETTING_PREFIX)
    ? ENCRYPTED_SETTING_PREFIX
    : value.startsWith(DRAFT_ENCRYPTED_SETTING_PREFIX)
      ? DRAFT_ENCRYPTED_SETTING_PREFIX
      : null

  if (!prefix) {
    return isLegacyEncryptedValue(value) ? decryptSecret(value) : value
  }

  const encryptionKey = resolveSettingsEncryptionKey()
  if (!encryptionKey) {
    throw new Error('SETTINGS_ENCRYPTION_KEY is required to read encrypted settings')
  }

  const payload = Buffer.from(value.slice(prefix.length), 'base64')
  const iv = payload.subarray(0, IV_LENGTH)
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAAD(aadForSetting(key))
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
