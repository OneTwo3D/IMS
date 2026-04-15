import { getSettingValue } from '@/lib/settings-store'

export type PublicAppUrlInfo = {
  value: string | null
  source: 'settings' | 'env' | 'none'
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, '')
}

export async function getPublicAppUrlInfo(): Promise<PublicAppUrlInfo> {
  const stored = normalizeUrl(await getSettingValue('public_app_url'))
  if (stored) return { value: stored, source: 'settings' }

  const envValue = normalizeUrl(process.env.NEXT_PUBLIC_APP_URL)
  if (envValue) return { value: envValue, source: 'env' }

  return { value: null, source: 'none' }
}

export async function getPublicAppUrl(): Promise<string | null> {
  return (await getPublicAppUrlInfo()).value
}
