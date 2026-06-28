/**
 * Pure helpers for the password-reset flow. The emailed link carries a
 * cryptographically-random token; only its SHA-256 hash is used as the
 * OneTimeToken key, so a database compromise never exposes a usable token.
 */
import { createHash, randomBytes } from 'crypto'

/** Reset links are valid for one hour. */
export const PASSWORD_RESET_TTL_MS = 60 * 60_000

/** A 256-bit URL-safe token to embed in the reset link. */
export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('hex')
}

/** OneTimeToken key for a reset token — the hash, never the raw token. */
export function passwordResetTokenKey(token: string): string {
  return `password_reset:${createHash('sha256').update(token).digest('hex')}`
}

/** Absolute reset URL for the email body, tolerant of a trailing slash on the base. */
export function buildPasswordResetUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/reset-password?token=${encodeURIComponent(token)}`
}
