/**
 * GET    /api/auth/totp-setup  — generate a new TOTP secret + QR code data URL
 * POST   /api/auth/totp-setup  — confirm code and enable 2FA
 * DELETE /api/auth/totp-setup  — disable 2FA (requires valid code)
 */
import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { TOTP } from 'otplib'
import QRCode from 'qrcode'
import { z } from 'zod'

const confirmSchema = z.object({ code: z.string().length(6), secret: z.string() })
const disableSchema = z.object({ code: z.string().length(6) })

export async function GET() {
  const session = await requireAuth()

  const secret = new TOTP().generateSecret()
  const otpAuthUrl = new TOTP({ secret, label: session.user.email, issuer: 'onetwoInventory' }).toURI()
  const qrDataUrl = await QRCode.toDataURL(otpAuthUrl)

  return Response.json({ secret, qrDataUrl })
}

export async function POST(request: NextRequest) {
  const session = await requireAuth()

  const body = await request.json()
  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const result = await new TOTP({ secret: parsed.data.secret }).verify(parsed.data.code)
  if (!result.valid) {
    return Response.json({ error: 'Invalid code — please try again' }, { status: 400 })
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { totpSecret: parsed.data.secret, totpEnabled: true },
  })

  return Response.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const session = await requireAuth()

  const body = await request.json()
  const parsed = disableSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { totpSecret: true },
  })
  if (!user?.totpSecret) {
    return Response.json({ error: '2FA not enabled' }, { status: 400 })
  }

  const result = await new TOTP({ secret: user.totpSecret }).verify(parsed.data.code)
  if (!result.valid) {
    return Response.json({ error: 'Invalid code' }, { status: 400 })
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { totpSecret: null, totpEnabled: false },
  })

  return Response.json({ success: true })
}
