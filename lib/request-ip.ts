import { isIP } from 'node:net'

type HeaderSource = Pick<Headers, 'get'>

type TrustedProxyRange = {
  family: 4 | 6
  bits: number
  network: bigint
  mask: bigint
}

function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null

  const bracketMatch = trimmed.match(/^\[([^[\]]+)\](?::\d+)?$/)
  const unwrapped = bracketMatch?.[1] ?? trimmed
  const maybeWithoutPort = unwrapped.includes('.') && unwrapped.split(':').length === 2
    ? unwrapped.split(':')[0]
    : unwrapped
  const normalized = maybeWithoutPort.toLowerCase().startsWith('::ffff:')
    ? maybeWithoutPort.slice(7)
    : maybeWithoutPort

  return isIP(normalized) ? normalized : null
}

function parseIpv4(ip: string): bigint {
  return ip.split('.').reduce<bigint>((acc, part) => (
    (acc << BigInt(8)) + BigInt(Number(part))
  ), BigInt(0))
}

function parseIpv6(ip: string): bigint {
  const [leftRaw, rightRaw] = ip.split('::')
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : []
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : []
  const missing = 8 - (left.length + right.length)
  if (missing < 0) throw new Error(`Invalid IPv6 address: ${ip}`)
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (parts.length !== 8) throw new Error(`Invalid IPv6 address: ${ip}`)

  return parts.reduce<bigint>((acc, part) => (
    (acc << BigInt(16)) + BigInt(parseInt(part || '0', 16))
  ), BigInt(0))
}

function parseIpToBigInt(ip: string): { family: 4 | 6; value: bigint } {
  const family = isIP(ip)
  if (family === 4) return { family: 4, value: parseIpv4(ip) }
  if (family === 6) return { family: 6, value: parseIpv6(ip) }
  throw new Error(`Invalid IP address: ${ip}`)
}

function createMask(bits: number, width: number): bigint {
  if (bits <= 0) return BigInt(0)
  if (bits >= width) return (BigInt(1) << BigInt(width)) - BigInt(1)
  return ((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(width - bits)
}

function parseTrustedProxyRange(value: string): TrustedProxyRange | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const [ipPart, bitsPart] = trimmed.split('/')
  const normalizedIp = normalizeIp(ipPart)
  if (!normalizedIp) return null

  const parsed = parseIpToBigInt(normalizedIp)
  const width = parsed.family === 4 ? 32 : 128
  const bits = bitsPart == null ? width : Number(bitsPart)
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null

  const mask = createMask(bits, width)
  return {
    family: parsed.family,
    bits,
    network: parsed.value & mask,
    mask,
  }
}

function parseEnvList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

const trustedProxyIps = new Set(
  parseEnvList('TRUSTED_PROXY_IPS')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => !!entry),
)

const trustedProxyRanges = parseEnvList('TRUSTED_PROXY_CIDRS')
  .map((entry) => parseTrustedProxyRange(entry))
  .filter((entry): entry is TrustedProxyRange => !!entry)

function isTrustedProxy(ip: string): boolean {
  if (trustedProxyIps.has(ip)) return true
  const parsed = parseIpToBigInt(ip)
  return trustedProxyRanges.some((range) => (
    range.family === parsed.family && (parsed.value & range.mask) === range.network
  ))
}

function getForwardedChain(headers: HeaderSource): string[] {
  return (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter((entry): entry is string => !!entry)
}

/**
 * Resolve the original client IP from proxy headers.
 *
 * Security contract:
 * - The reverse proxy in front of the app must strip/replace any incoming
 *   `X-Forwarded-For` header before proxying.
 * - Each trusted proxy must append its immediate peer to the right-hand side of
 *   `X-Forwarded-For`.
 * - `TRUSTED_PROXY_IPS` / `TRUSTED_PROXY_CIDRS` should include every internal
 *   proxy hop except the original client.
 *
 * With that contract, the client IP is the first non-trusted address when
 * walking the chain from right to left. If no forwarded chain exists, fall back
 * to `X-Real-IP` when present.
 */
export function getClientIp(headers: HeaderSource): string | null {
  const forwardedChain = getForwardedChain(headers)
  if (forwardedChain.length > 0) {
    for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
      const ip = forwardedChain[index]
      if (!isTrustedProxy(ip)) return ip
    }
    return null
  }

  return normalizeIp(headers.get('x-real-ip'))
}
