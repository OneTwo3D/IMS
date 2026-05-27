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
import { generateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'
import { z } from 'zod'
import { readTotpSecrets, serializeTotpSecret } from '@/lib/totp-secrets'

const confirmSchema = z.object({ code: z.string().length(6) })
const disableSchema = z.object({ code: z.string().length(6) })

export async function GET() {
  const session = await requireApiAuth()
  if ('headers' in session) return session

  const secret = generateSecret()
  const otpAuthUrl = generateURI({ secret, label: session.user.email, issuer: 'onetwoInventory' })
  const qrDataUrl = await QRCode.toDataURL(otpAuthUrl)

  // Stage the secret server-side so POST can use it without trusting the client.
  await db.user.update({
    where: { id: session.user.id },
    data: { pendingTotpSecret: serializeTotpSecret(secret) },
  })

  return Response.json({ secret, qrDataUrl })
}

export async function POST(request: NextRequest) {
  const session = await requireApiAuth()
  if ('headers' in session) return session

  const body = await request.json()
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.pendingTotpSecret) {
    return Response.json({ error: 'No pending 2FA setup — start again' }, { status: 400 })
  }

  const result = await verify({ secret: secrets.pendingTotpSecret, token: parsed.data.code })
  if (!result.valid) {
    return Response.json({ error: 'Invalid code — please try again' }, { status: 400 })
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

  return Response.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireApiAuth()
  if ('headers' in session) return session

  const body = await request.json()
  const parsed = disableSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const secrets = await readTotpSecrets(session.user.id)
  if (!secrets?.totpSecret) {
    return Response.json({ error: '2FA not enabled' }, { status: 400 })
  }

  const result = await verify({ secret: secrets.totpSecret, token: parsed.data.code })
  if (!result.valid) {
    return Response.json({ error: 'Invalid code' }, { status: 400 })
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

  return Response.json({ success: true })
}
