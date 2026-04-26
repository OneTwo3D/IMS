import { createHash } from 'crypto'

export function accountingPayloadKey(prefix: string, payload: Record<string, unknown>): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}
