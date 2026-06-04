/**
 * GET    /api/auth/totp-setup  — generate a new TOTP secret + QR code data URL
 *                                (secret is staged server-side on the user row)
 * POST   /api/auth/totp-setup  — confirm code and enable 2FA
 * DELETE /api/auth/totp-setup  — disable 2FA (requires valid code)
 */
import { NextRequest } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { verify } from 'otplib'
import { z } from 'zod'
import { readTotpSecrets, serializeTotpSecret } from '@/lib/totp-secrets'
import { defaultTotpSetupGetDependencies, handleTotpSetupGet, totpJsonResponse } from './handler'

const confirmSchema = z.object({ code: z.string().length(6) })
const disableSchema = z.object({ code: z.string().length(6) })

export async function GET() {
  return handleTotpSetupGet(defaultTotpSetupGetDependencies)
}

export async function POST(request: NextRequest) {
  const session = await requireApiAuth()
  if ('headers' in session) return session

  const body = await request.json()
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return totpJsonResponse({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.pendingTotpSecret) {
    return totpJsonResponse({ error: 'No pending 2FA setup — start again' }, { status: 400 })
  }

  const result = await verify({ secret: secrets.pendingTotpSecret, token: parsed.data.code })
  if (!result.valid) {
    return totpJsonResponse({ error: 'Invalid code — please try again' }, { status: 400 })
  }

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

  const body = await request.json()
  const parsed = disableSchema.safeParse(body)
  if (!parsed.success) {
    return totpJsonResponse({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.totpSecret) {
    return totpJsonResponse({ error: '2FA not enabled' }, { status: 400 })
  }

  const result = await verify({ secret: secrets.totpSecret, token: parsed.data.code })
  if (!result.valid) {
    return totpJsonResponse({ error: 'Invalid code' }, { status: 400 })
  }

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
