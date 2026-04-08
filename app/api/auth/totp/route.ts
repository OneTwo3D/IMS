/**
 * POST /api/auth/totp
 * Verifies a TOTP code during the 2FA challenge step.
 * Returns a one-time token the client uses to securely update the session.
 */
import { randomBytes } from 'crypto'
import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { TOTP } from 'otplib'
import { z } from 'zod'
import { setAuthToken } from '@/lib/auth/token-store'

const schema = z.object({ code: z.string().length(6) })

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid code format' }, { status: 400 })
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { totpSecret: true, totpEnabled: true },
  })

  if (!user?.totpEnabled || !user.totpSecret) {
    return Response.json({ error: '2FA not enabled' }, { status: 400 })
  }

  const totp = new TOTP({ secret: user.totpSecret })
  const result = await totp.verify(parsed.data.code)

  if (!result.valid) {
    return Response.json({ error: 'Invalid code' }, { status: 400 })
  }

  // Generate a one-time token for secure session update
  const totpToken = randomBytes(32).toString('hex')
  setAuthToken(`totp_verify:${totpToken}`, session.user.id, 60_000) // 60s TTL

  return Response.json({ success: true, totpToken })
}
