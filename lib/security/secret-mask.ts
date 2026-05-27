export const SECRET_MASK = '****'

export function maskSecret(value: string | null | undefined, visibleChars = 4): string {
  if (!value) return ''
  return `${value.slice(0, Math.max(0, visibleChars))}${SECRET_MASK}`
}

export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.includes(SECRET_MASK)
}

export function shouldFreshGateSecretWrite(data: object, key: string): boolean {
  if (!Object.hasOwn(data, key)) return false
  return !isMaskedSecret((data as Record<string, unknown>)[key])
}
