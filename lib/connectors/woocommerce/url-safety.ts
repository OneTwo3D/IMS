import { isIP } from 'net'

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true
  const parts = normalized.split('.').map((part) => Number.parseInt(part, 10))
  return parts.length === 4 && parts[0] === 127
}

export function validateWooCommerceBaseUrl(rawUrl: string): { ok: true; normalizedUrl: string } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'WooCommerce URL is invalid.' }
  }

  const host = parsed.hostname.toLowerCase()
  const allowE2eLocalHttp = process.env.E2E_TEST_MODE === '1' && parsed.protocol === 'http:' && isLoopbackHost(host)

  if (parsed.protocol !== 'https:' && !allowE2eLocalHttp) {
    return { ok: false, error: 'WooCommerce URL must use https.' }
  }

  if (!allowE2eLocalHttp && (host === 'localhost' || host.endsWith('.localhost'))) {
    return { ok: false, error: 'WooCommerce URL cannot target localhost.' }
  }

  const ipVersion = isIP(host)
  if (!allowE2eLocalHttp && ((ipVersion === 4 && isPrivateIpv4(host)) || (ipVersion === 6 && isPrivateIpv6(host)))) {
    return { ok: false, error: 'WooCommerce URL cannot target loopback, link-local, or private network addresses.' }
  }

  return { ok: true, normalizedUrl: parsed.toString().replace(/\/$/, '') }
}
