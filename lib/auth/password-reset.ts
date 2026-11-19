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

export const PASSWORD_RESET_COOLDOWN_MS = 2 * 60_000

type ResetLimiter = (key: string, max: number, windowMs: number) => Promise<{ allowed: boolean }>

/**
 * Whether a reset request may send an email. The caller answers the same silent
 * acknowledgement either way.
 *
 * Nothing here can stop a victim's own reset: the only per-address limit is a short
 * COOLDOWN (at most one email per address per 2 minutes), so an attacker who spams an
 * address only means a reset email has just been sent to the owner's inbox. The hard
 * caps are per source IP and are skipped when the IP is unknown (they would be one
 * shared bucket for everybody).
 */
export async function passwordResetEmailAllowed(input: {
  email: string
  ip: string
  limiter: ResetLimiter
}): Promise<boolean> {
  const { email, ip, limiter } = input
  if (ip !== 'unknown') {
    if (!(await limiter(`pwreset-ip:${ip}`, 20, 15 * 60_000)).allowed) return false
    if (!(await limiter(`pwreset:${email}:${ip}`, 5, 15 * 60_000)).allowed) return false
  }
  return (await limiter(`pwreset-cool:${email}`, 1, PASSWORD_RESET_COOLDOWN_MS)).allowed
}
