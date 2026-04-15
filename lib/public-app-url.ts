import { getSettingValue } from '@/lib/settings-store'

export type PublicAppUrlInfo = {
  value: string | null
  source: 'settings' | 'none'
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, '')
}

export async function getPublicAppUrlInfo(): Promise<PublicAppUrlInfo> {
  const stored = normalizeUrl(await getSettingValue('public_app_url'))
  if (stored) return { value: stored, source: 'settings' }

  return { value: null, source: 'none' }
}

export async function getPublicAppUrl(): Promise<string | null> {
  return (await getPublicAppUrlInfo()).value
}

function normalizeHost(value: string | null | undefined): string | null {
  const host = value?.split(',')[0]?.trim()
  return host ? host.replace(/\/+$/, '') : null
}

function normalizeProto(value: string | null | undefined): 'http' | 'https' | null {
  const proto = value?.split(',')[0]?.trim().toLowerCase()
  if (proto === 'http' || proto === 'https') return proto
  return null
}

export function detectPublicAppUrlFromHeaders(input: {
  forwardedHost?: string | null
  forwardedProto?: string | null
  host?: string | null
}): string | null {
  const host = normalizeHost(input.forwardedHost) ?? normalizeHost(input.host)
  if (!host) return null

  const proto = normalizeProto(input.forwardedProto)
    ?? (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')

  return `${proto}://${host}`
}
