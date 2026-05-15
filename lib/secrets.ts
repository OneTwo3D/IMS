import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const ENCRYPTED_PREFIX = 'enc:v1:'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function resolveEncryptionKey(): Buffer | null {
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

  // Allow deterministic migration from older ad-hoc keys without silently
  // truncating. This still yields a 32-byte AES-256 key.
  return createHash('sha256').update(trimmed).digest()
}

export function isEncryptedValue(value: string | null | undefined): value is string {
  return !!value && value.startsWith(ENCRYPTED_PREFIX)
}

export function encryptSecret(plaintext: string): string {
  const key = resolveEncryptionKey()
  if (!key) {
    throw new Error('SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY is required to store encrypted secrets')
  }

  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, authTag, ciphertext]).toString('base64')}`
}

export function decryptSecret(value: string): string {
  if (!isEncryptedValue(value)) return value

  const key = resolveEncryptionKey()
  if (!key) {
    throw new Error('SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY is required to read encrypted secrets')
  }

  const payload = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64')
  const iv = payload.subarray(0, IV_LENGTH)
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function hasEncryptionKey(): boolean {
  return resolveEncryptionKey() !== null
}
