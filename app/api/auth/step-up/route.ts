/**
 * POST /api/auth/step-up
 * Re-verifies the CURRENT user's credentials (password, plus TOTP when enabled)
 * to satisfy the step-up "fresh auth" gate (requireFreshAdmin/Permission) without
 * a full sign-out/in. On success it issues a one-time token the client passes to
 * session.update({ _stepUpToken }) — the jwt callback consumes it and refreshes
 * sessionAuthTime in place. Mirrors the /api/auth/totp one-time-token pattern.
 */
import { randomBytes } from 'crypto'
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { verify } from 'otplib'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { setAuthToken } from '@/lib/auth/token-store'
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { readTotpSecrets } from '@/lib/totp-secrets'

// Same dummy hash used by the login authorize() path so a missing passwordHash
// still does constant-ish work and never short-circuits to a different answer.
const DUMMY_BCRYPT_HASH = '$2b$12$Q7QxTQqR0p6vJY9Yx1m8JOkjH3J0mD6G4jY6YtV2v0mL4YvM1gM9S'

const schema = z.object({
  password: z.string().min(1),
  code: z.string().length(6).optional(),
})

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 })
  }
  if (session.user.sessionInvalidReason) {
    return Response.json({ error: 'Session expired' }, { status: 401 })
  }

  const rlKey = `step_up:${session.user.id}`
  const rl = await checkRateLimit(rlKey, 5, 5 * 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Too many attempts, try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, passwordHash: true, totpEnabled: true, active: true },
  })
  if (!user || !user.active) {
    return Response.json({ error: 'Session expired' }, { status: 401 })
  }

  const passwordMatch = await bcrypt.compare(parsed.data.password, user.passwordHash ?? DUMMY_BCRYPT_HASH)
  if (!user.passwordHash || !passwordMatch) {
    return Response.json({ error: 'Incorrect password' }, { status: 400 })
  }

  // When 2FA is enabled, require a valid current code too — step-up must be at
  // least as strong as the original sign-in.
  if (user.totpEnabled) {
    const code = parsed.data.code
    if (!code) {
      return Response.json({ error: 'Authenticator code required', totpRequired: true }, { status: 400 })
    }
    const secrets = await readTotpSecrets(user.id)
    if (!secrets?.totpSecret) {
      return Response.json({ error: '2FA not configured' }, { status: 400 })
    }
    const result = await verify({ secret: secrets.totpSecret, token: code })
    if (!result.valid) {
      return Response.json({ error: 'Invalid authenticator code', totpRequired: true }, { status: 400 })
    }
  }

  await clearRateLimit(rlKey)

  const stepUpToken = randomBytes(32).toString('hex')
  await setAuthToken(`step_up:${stepUpToken}`, user.id, 60_000) // 60s TTL

  return Response.json({ success: true, stepUpToken })
}
