/**
 * GET    /api/auth/totp-setup  — generate a new TOTP secret + QR code data URL
 *                                (secret is staged server-side on the user row)
 * POST   /api/auth/totp-setup  — confirm code and enable 2FA
 * DELETE /api/auth/totp-setup  — disable 2FA (requires valid code)
 */
import { NextRequest } from 'next/server'
import { requireApiAuth, requireApiFreshAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { verify } from 'otplib'
import { z } from 'zod'
import { readTotpSecrets, serializeTotpSecret } from '@/lib/totp-secrets'
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { verifyTotpCodeOnce } from '@/lib/auth/totp-replay'
import { defaultTotpSetupGetDependencies, handleTotpSetupGet, totpJsonResponse } from './handler'

const confirmSchema = z.object({ code: z.string().length(6) })
const disableSchema = z.object({ code: z.string().length(6) })

/**
 * Per-user cap on code guesses against the confirm / disable endpoints. Without it a
 * hijacked (non-pending) session could brute-force the code to switch 2FA off.
 */
async function consumeSetupAttempt(userId: string): Promise<Response | null> {
  const rl = await checkRateLimit(`totp_setup:${userId}`, 5, 5 * 60_000, { failClosed: true })
  if (rl.allowed) return null
  return totpJsonResponse(
    { error: 'Too many attempts, try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
  )
}

export async function GET() {
  return handleTotpSetupGet(defaultTotpSetupGetDependencies)
}

export async function POST(request: NextRequest) {
  // Enabling (or replacing) the authenticator needs a recently re-authenticated
  // session: a stolen session must not be able to swap in the attacker's secret.
  const session = await requireApiFreshAuth()
  if ('headers' in session) return session
  const throttled = await consumeSetupAttempt(session.user.id)
  if (throttled) return throttled

  const body = await request.json()
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return totpJsonResponse({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.pendingTotpSecret) {
    return totpJsonResponse({ error: 'No pending 2FA setup — start again' }, { status: 400 })
  }

  // Not recorded as a used step: this proves the NEW secret, which no sign-in can replay,
  // and burning the step would make the user's next sign-in code "already used".
  const result = await verify({ secret: secrets.pendingTotpSecret, token: parsed.data.code })
  if (!result.valid) {
    return totpJsonResponse({ error: 'Invalid code — please try again' }, { status: 400 })
  }
  await clearRateLimit(`totp_setup:${session.user.id}`)

  await db.user.update({
    where: { id: session.user.id },
    data: {
      totpSecret: serializeTotpSecret(secrets.pendingTotpSecret),
      totpEnabled: true,
      pendingTotpSecret: null,
      sessionVersion: { increment: 1 },
    },
  })

  await logActivity({
    entityType: 'USER',
    entityId: session.user.id,
    tag: 'auth',
    action: 'updated',
    description: 'Enabled two-factor authentication (TOTP)',
  })

  return totpJsonResponse({ success: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireApiAuth()
  if ('headers' in session) return session
  const throttled = await consumeSetupAttempt(session.user.id)
  if (throttled) return throttled

  const body = await request.json()
  const parsed = disableSchema.safeParse(body)
  if (!parsed.success) {
    return totpJsonResponse({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.totpSecret) {
    return totpJsonResponse({ error: '2FA not enabled' }, { status: 400 })
  }

  const outcome = await verifyTotpCodeOnce({
    userId: session.user.id,
    secret: secrets.totpSecret,
    code: parsed.data.code,
  })
  if (outcome === 'replayed') {
    return totpJsonResponse({ error: 'That code was already used. Wait for the next code.' }, { status: 400 })
  }
  if (outcome !== 'ok') {
    return totpJsonResponse({ error: 'Invalid code' }, { status: 400 })
  }
  await clearRateLimit(`totp_setup:${session.user.id}`)

  await db.user.update({
    where: { id: session.user.id },
    data: {
      totpSecret: null,
      totpEnabled: false,
      pendingTotpSecret: null,
      sessionVersion: { increment: 1 },
    },
  })

  await logActivity({
    entityType: 'USER',
    entityId: session.user.id,
    tag: 'auth',
    action: 'updated',
    description: 'Disabled two-factor authentication (TOTP)',
  })

  return totpJsonResponse({ success: true })
}
