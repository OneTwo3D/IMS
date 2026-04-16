import { getClientIp } from '@/lib/request-ip'

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function getTurnstileSiteKey(): string | null {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()
  return siteKey ? siteKey : null
}

export function getTurnstileSecretKey(): string | null {
  const secretKey = process.env.TURNSTILE_SECRET_KEY?.trim()
  return secretKey ? secretKey : null
}

export function isTurnstileEnabled(): boolean {
  return !!getTurnstileSiteKey() && !!getTurnstileSecretKey()
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  headers?: Pick<Headers, 'get'>,
): Promise<boolean> {
  const secretKey = getTurnstileSecretKey()
  if (!secretKey) return true
  if (!token) return false

  const formData = new FormData()
  formData.set('secret', secretKey)
  formData.set('response', token)

  const clientIp = headers ? getClientIp(headers) : null
  if (clientIp) {
    formData.set('remoteip', clientIp)
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
      cache: 'no-store',
    })
    if (!response.ok) return false

    const payload = await response.json() as { success?: boolean }
    return payload.success === true
  } catch {
    return false
  }
}
