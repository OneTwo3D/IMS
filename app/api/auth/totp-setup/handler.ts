import QRCode from 'qrcode'
import { generateSecret, generateURI } from 'otplib'
import { requireApiAuth } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { serializeTotpSecret } from '@/lib/totp-secrets'
import type { AuthSession } from '@/lib/auth/server'

export function totpJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(body, { ...init, headers })
}

type TotpSetupGetDependencies = {
  authorize: () => Promise<AuthSession | Response>
  generateSecret: () => string
  generateUri: (input: { secret: string; label: string; issuer: string }) => string
  generateQrDataUrl: (input: string) => Promise<string>
  stageSecret: (userId: string, secret: string) => Promise<void>
}

export async function handleTotpSetupGet(dependencies: TotpSetupGetDependencies): Promise<Response> {
  const session = await dependencies.authorize()
  if (session instanceof Response) return session

  const secret = dependencies.generateSecret()
  const otpAuthUrl = dependencies.generateUri({ secret, label: session.user.email, issuer: 'onetwoInventory' })
  const qrDataUrl = await dependencies.generateQrDataUrl(otpAuthUrl)

  // Stage the secret server-side so POST can use it without trusting the client.
  await dependencies.stageSecret(session.user.id, secret)

  return totpJsonResponse({ qrDataUrl })
}

export const defaultTotpSetupGetDependencies: TotpSetupGetDependencies = {
  authorize: requireApiAuth,
  generateSecret,
  generateUri: generateURI,
  generateQrDataUrl: QRCode.toDataURL,
  async stageSecret(userId, secret) {
    await db.user.update({
      where: { id: userId },
      data: { pendingTotpSecret: serializeTotpSecret(secret) },
    })
  },
}
