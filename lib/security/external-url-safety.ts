import { isIP } from 'node:net'

export type ExternalUrlSafetyOptions = {
  connectorName: string
  allowMissingProtocol?: boolean
  allowE2eLocalHttp?: boolean
  privateIpAllowlist?: string | readonly string[]
  env?: Record<string, string | undefined>
}

export type ExternalUrlSafetyResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string }

export type ExternalResolvedAddressSafetyResult =
  | { ok: true }
  | { ok: false; error: string }

const CLOUD_METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
])

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function normalizeHost(host: string): string {
  return stripIpv6Brackets(host.trim().toLowerCase()).replace(/\.$/, '')
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return parts as [number, number, number, number]
}

export function isUnsafeIpv4(host: string): boolean {
  const parts = parseIpv4(host)
  if (!parts) return false

  const [a, b] = parts
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function parseIpv4MappedIpv6(host: string): string | null {
  const normalized = host.toLowerCase()
  if (!normalized.startsWith('::ffff:')) return null

  const tail = normalized.slice('::ffff:'.length)
  if (tail.includes('.')) return tail

  const hextets = tail.split(':')
  if (hextets.length < 1 || hextets.length > 2) return null

  const high = Number.parseInt(hextets[0] || '0', 16)
  const low = Number.parseInt(hextets[1] || '0', 16)
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return null
  }

  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.')
}

export function isUnsafeIpv6(host: string): boolean {
  const normalized = normalizeHost(host)
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16)
  if (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) return true

  const mappedIpv4 = parseIpv4MappedIpv6(normalized)
  return mappedIpv4 ? isUnsafeIpv4(mappedIpv4) : false
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1') return true
  const ipv4 = parseIpv4(normalized)
  return Boolean(ipv4 && ipv4[0] === 127)
}

export function isUnsafeHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (CLOUD_METADATA_HOSTS.has(normalized)) return true
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) return isUnsafeIpv4(normalized)
  if (ipVersion === 6) return isUnsafeIpv6(normalized)

  return false
}

function normalizeUrlForStorage(url: URL): string {
  return url.toString().replace(/\/+$/, '')
}

function ipv4ToNumber(ip: string): number | null {
  const parts = parseIpv4(ip)
  if (!parts) return null
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  const normalized = normalizeHost(ip)
  const ipv4TailMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  let expandedInput = normalized
  if (ipv4TailMatch) {
    const ipv4Number = ipv4ToNumber(ipv4TailMatch[2])
    if (ipv4Number == null) return null
    expandedInput = `${ipv4TailMatch[1]}${(ipv4Number >>> 16).toString(16)}:${(ipv4Number & 0xffff).toString(16)}`
  }

  const [leftRaw, rightRaw, extra] = expandedInput.split('::')
  if (extra !== undefined) return null

  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : []
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : []
  const missing = rightRaw === undefined ? 0 : 8 - left.length - right.length
  if (missing < 0) return null

  const hextets = rightRaw === undefined
    ? left
    : [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (hextets.length !== 8) return null

  let value = BigInt(0)
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null
    value = (value << BigInt(16)) + BigInt(Number.parseInt(hextet, 16))
  }
  return value
}

function parseAllowlistSource(
  allowlist: string | readonly string[] | undefined,
  env?: Record<string, string | undefined>,
): string[] {
  const configured = allowlist ?? env?.CONNECTOR_PRIVATE_IP_ALLOWLIST ?? process.env.CONNECTOR_PRIVATE_IP_ALLOWLIST
  if (!configured) return []
  const entries: readonly string[] = typeof configured === 'string' ? configured.split(',') : configured
  return entries
    .map((entry: string) => entry.trim())
    .filter(Boolean)
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixRaw, extra] = cidr.split('/')
  if (extra !== undefined || !rangeIp || prefixRaw == null) return false
  const family = isIP(ip)
  if (!family || isIP(rangeIp) !== family) return false

  const prefix = Number(prefixRaw)
  if (!Number.isInteger(prefix)) return false

  if (family === 4) {
    if (prefix < 0 || prefix > 32) return false
    const ipNumber = ipv4ToNumber(ip)
    const rangeNumber = ipv4ToNumber(rangeIp)
    if (ipNumber == null || rangeNumber == null) return false
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return (ipNumber & mask) === (rangeNumber & mask)
  }

  if (prefix < 0 || prefix > 128) return false
  const ipNumber = parseIpv6ToBigInt(ip)
  const rangeNumber = parseIpv6ToBigInt(rangeIp)
  if (ipNumber == null || rangeNumber == null) return false
  const hostBits = BigInt(128 - prefix)
  const mask = prefix === 0
    ? BigInt(0)
    : ((BigInt(1) << BigInt(128)) - BigInt(1)) ^ ((BigInt(1) << hostBits) - BigInt(1))
  return (ipNumber & mask) === (rangeNumber & mask)
}

function isAllowlistedIp(ip: string, entries: readonly string[]): boolean {
  const family = isIP(ip)
  if (!family) return false

  return entries.some((entry) => {
    if (entry.includes('/')) return isIpInCidr(ip, entry)
    if (isIP(entry) !== family) return false
    if (family === 4) return ipv4ToNumber(ip) === ipv4ToNumber(entry)
    return parseIpv6ToBigInt(ip) === parseIpv6ToBigInt(entry)
  })
}

function isPrivateConnectorIp(host: string): boolean {
  const normalized = normalizeHost(host)
  const ipv4 = parseIpv4(normalized)
  if (ipv4) {
    const [a, b] = ipv4
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return isIP(normalized) === 6 && (normalized.startsWith('fc') || normalized.startsWith('fd'))
}

function unsafeHostAllowedByPrivateIpAllowlist(
  host: string,
  allowlist: string | readonly string[] | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  const normalized = normalizeHost(host)
  if (!isIP(normalized)) return false
  if (!isPrivateConnectorIp(normalized)) return false
  return isAllowlistedIp(normalized, parseAllowlistSource(allowlist, env))
}

export function validateExternalResolvedAddress(
  address: string,
  options: Pick<ExternalUrlSafetyOptions, 'connectorName' | 'privateIpAllowlist' | 'env'>,
): ExternalResolvedAddressSafetyResult {
  const normalized = normalizeHost(address)
  if (!isIP(normalized)) {
    return { ok: false, error: `${options.connectorName} URL resolved to an invalid IP address.` }
  }

  if (isUnsafeHost(normalized) && !unsafeHostAllowedByPrivateIpAllowlist(normalized, options.privateIpAllowlist, options.env)) {
    return { ok: false, error: `${options.connectorName} URL resolved to a blocked loopback, link-local, private, or metadata network address.` }
  }

  return { ok: true }
}

/**
 * Validates connector base URL strings before they are stored or used.
 *
 * This validates the connector URL string before storage/use. Outbound connector
 * requests must still use a DNS-validating HTTP client so hostnames cannot
 * resolve or rebind to blocked addresses at request time.
 */
export function validateExternalBaseUrl(
  rawUrl: string,
  options: ExternalUrlSafetyOptions,
): ExternalUrlSafetyResult {
  let parsed: URL
  try {
    const trimmed = rawUrl.trim()
    const withProtocol = options.allowMissingProtocol && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? `https://${trimmed}`
      : trimmed
    parsed = new URL(withProtocol)
  } catch {
    return { ok: false, error: `${options.connectorName} URL is invalid.` }
  }

  const host = normalizeHost(parsed.hostname)
  const e2eMode = options.env?.E2E_TEST_MODE ?? process.env.E2E_TEST_MODE
  const nodeEnv = options.env?.NODE_ENV ?? process.env.NODE_ENV
  const allowLocalHttp = options.allowE2eLocalHttp === true
    && e2eMode === '1'
    && nodeEnv !== 'production'
    && parsed.protocol === 'http:'
    && isLoopbackHost(host)

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, error: `${options.connectorName} URL must not include credentials, query, or fragment.` }
  }

  if (parsed.protocol !== 'https:' && !allowLocalHttp) {
    return { ok: false, error: `${options.connectorName} URL must use https.` }
  }

  if (!allowLocalHttp && (host === 'localhost' || host.endsWith('.localhost'))) {
    return { ok: false, error: `${options.connectorName} URL cannot target localhost.` }
  }

  if (
    !allowLocalHttp
    && isUnsafeHost(host)
    && !unsafeHostAllowedByPrivateIpAllowlist(host, options.privateIpAllowlist, options.env)
  ) {
    return { ok: false, error: `${options.connectorName} URL cannot target loopback, link-local, private, or metadata network addresses.` }
  }

  return { ok: true, normalizedUrl: normalizeUrlForStorage(parsed) }
}
