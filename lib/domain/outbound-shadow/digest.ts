import { createHash } from 'node:crypto'

/**
 * The canonical JSON of a payload: object keys sorted at every depth, no whitespace, `undefined` dropped as JSON
 * drops it, a Date as its ISO instant, anything with `toFixed` and `toString` (a Decimal) as its decimal string.
 * Top-level keys that start with an underscore are BOOKKEEPING STAMPS (the connection stamp, the posting mode, the
 * idempotency token) and are removed, so the same work produced twice digests the same.
 */
export function canonicalizeForDigest(value: unknown, topLevel = true): string {
  if (value === null || value === undefined) return 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeForDigest(item === undefined ? null : item, false)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.constructor?.name === 'Decimal') return JSON.stringify(String(record))
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined && !(topLevel && key.startsWith('_')))
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeForDigest(record[key], false)}`).join(',')}}`
  }
  return 'null'
}

/** sha256 (lower-case hex, 64 characters) of {@link canonicalizeForDigest}. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalizeForDigest(payload)).digest('hex')
}
