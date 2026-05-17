import { Prisma } from '@/app/generated/prisma/client'

/**
 * Sanitizes a value for JSONB storage via JSON round-trip. Drops `undefined`
 * properties, converts Date values to ISO strings, and calls Decimal.toJSON()
 * for string form. Throws on circular references. Map and Set flatten to {};
 * pre-flatten those types before passing them in if entries are expected.
 */
export function toJsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}
