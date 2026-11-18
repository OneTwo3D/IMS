/**
 * TOTP verification that refuses to accept the same code twice.
 *
 * A 6-digit code stays valid for its whole 30 s step, so an observed code (shoulder
 * surf, proxy log, phishing relay) could otherwise be replayed against /api/auth/totp,
 * step-up or 2FA disable inside that window. After a code verifies, the matched time
 * step is recorded per user in the existing one_time_tokens table (no schema change);
 * a second verification of the same step is rejected as `replayed`.
 *
 * The record is claimed with a unique-key INSERT, so two concurrent requests carrying
 * the same code cannot both win.
 */
import { verify } from 'otplib'
import { db } from '@/lib/db'

const TOTP_PERIOD_SECONDS = 30
// Long enough to outlive the step (and a skewed clock) - rows are swept by token-store.
const USED_STEP_TTL_MS = 3 * TOTP_PERIOD_SECONDS * 1000

export type TotpCheckResult = 'ok' | 'invalid' | 'replayed'

export function usedTotpStepKey(userId: string, step: number): string {
  return `totp_used:${userId}:${step}`
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/** Records the step as used. Returns false when it was already recorded. */
export async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const key = usedTotpStepKey(userId, step)
  // A leftover row past its expiry must not block a legitimate reuse of the key.
  await db.oneTimeToken.deleteMany({ where: { key, expiresAt: { lt: new Date() } } })
  try {
    await db.oneTimeToken.create({
      data: { key, value: userId, expiresAt: new Date(Date.now() + USED_STEP_TTL_MS) },
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
}

export async function verifyTotpCodeOnce(input: {
  userId: string
  secret: string
  code: string
}): Promise<TotpCheckResult> {
  // Pin the clock so the verified step and the recorded step cannot straddle a boundary.
  const epoch = Math.floor(Date.now() / 1000)
  const result = await verify({ secret: input.secret, token: input.code, epoch })
  if (!result.valid) return 'invalid'
  const step = Math.floor(epoch / TOTP_PERIOD_SECONDS) + result.delta
  return (await claimTotpStep(input.userId, step)) ? 'ok' : 'replayed'
}
