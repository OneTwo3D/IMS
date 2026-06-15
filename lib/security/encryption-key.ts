/**
 * audit-gzz2: single source of truth for resolving the AES-256 settings/secrets
 * encryption key from the environment. Both lib/security/encrypted-settings.ts
 * and lib/secrets.ts previously duplicated this logic and accepted ONLY a raw
 * 32-byte key or base64 that decodes to 32 bytes — silently rejecting a 64-char
 * hex key (e.g. `openssl rand -hex 32`, a very common format), which then threw a
 * misleading "key is required" error even though a key was configured.
 *
 * Accepted formats (all yield a 32-byte AES-256 key):
 *  - base64 that decodes to exactly 32 bytes   (`openssl rand -base64 32`)
 *  - 64 hexadecimal characters                 (`openssl rand -hex 32`)
 *  - a raw 32-byte UTF-8 string
 */
const HEX_64 = /^[0-9a-fA-F]{64}$/

/** Pure parse — returns the 32-byte key or null. Exported for unit testing. */
export function parseAesEncryptionKey(raw: string | null | undefined): Buffer | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 64-char hex (openssl rand -hex 32). Checked before base64 because hex chars
  // are also valid base64 chars but decode to 48 bytes, not 32.
  if (HEX_64.test(trimmed)) {
    const hex = Buffer.from(trimmed, 'hex')
    if (hex.length === 32) return hex
  }

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

/** Resolve from SETTINGS_ENCRYPTION_KEY (preferred) or legacy ENCRYPTION_KEY. */
export function resolveAesEncryptionKey(): Buffer | null {
  return parseAesEncryptionKey(process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY)
}

/**
 * Actionable error message used when the key is missing or unparseable, so the
 * operator knows a key may be *present but wrong-format* and how to generate one.
 */
export function missingEncryptionKeyMessage(action: string): string {
  const present = Boolean((process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY)?.trim())
  const reason = present
    ? 'SETTINGS_ENCRYPTION_KEY is set but is not a valid 32-byte key'
    : 'SETTINGS_ENCRYPTION_KEY is required'
  return `${reason} to ${action}. Provide a 32-byte AES key as base64 (openssl rand -base64 32), 64-char hex (openssl rand -hex 32), or a raw 32-byte string.`
}
