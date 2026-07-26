import { uniqueViolationTargetsField } from '@/lib/db/prisma-unique-violation'

/**
 * Is this the `accounting_events.idempotencyKey` unique violation — i.e. the mirror/backfill
 * lost a race and the event it wanted to write already exists?
 *
 * o3d-5od: this used to read `error.meta.target` only, which the pg driver adapter never
 * populates. See lib/db/prisma-unique-violation.ts.
 */
export function isIdempotencyKeyUniqueError(error: unknown): boolean {
  return uniqueViolationTargetsField(error, 'idempotencyKey')
}
