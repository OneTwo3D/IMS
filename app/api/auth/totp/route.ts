/**
 * POST /api/auth/totp
 * Verifies a TOTP code during the 2FA challenge step.
 * Returns a one-time token the client uses to securely update the session.
 */
import { randomBytes } from 'crypto'
import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { verify } from 'otplib'
import { z } from 'zod'
import { setAuthToken } from '@/lib/auth/token-store'
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit'
import { readTotpSecrets } from '@/lib/totp-secrets'

const schema = z.object({ code: z.string().length(6) })

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const rlKey = `totp_verify:${session.user.id}`
  const rl = checkRateLimit(rlKey, 5, 5 * 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Too many attempts, try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    )
  }

  const body = await request.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid code format' }, { status: 400 })
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { totpEnabled: true },
  })
  const secrets = await readTotpSecrets(session.user.id)
  if (!user?.totpEnabled || !secrets?.totpSecret) {
    return Response.json({ error: '2FA not enabled' }, { status: 400 })
  }

  const result = await verify({ secret: secrets.totpSecret, token: parsed.data.code })

  if (!result.valid) {
    return Response.json({ error: 'Invalid code' }, { status: 400 })
  }

  // Success — clear the rate-limit bucket so the next genuine verify is clean.
  clearRateLimit(rlKey)

  // Generate a one-time token for secure session update
  const totpToken = randomBytes(32).toString('hex')
  await setAuthToken(`totp_verify:${totpToken}`, session.user.id, 60_000) // 60s TTL

  return Response.json({ success: true, totpToken })
}
