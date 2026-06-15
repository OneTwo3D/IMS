import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { missingEncryptionKeyMessage, resolveAesEncryptionKey } from '@/lib/security/encryption-key'

const ENCRYPTED_PREFIX = 'enc:v1:'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

// audit-gzz2: shared resolver (accepts base64-32, 64-char hex, or raw 32-byte).
const resolveEncryptionKey = resolveAesEncryptionKey

export function isEncryptedValue(value: string | null | undefined): value is string {
  return !!value && value.startsWith(ENCRYPTED_PREFIX)
}

export function encryptSecret(plaintext: string): string {
  const key = resolveEncryptionKey()
  if (!key) {
    throw new Error(missingEncryptionKeyMessage('store encrypted secrets'))
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
    throw new Error(missingEncryptionKeyMessage('read encrypted secrets'))
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
