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

/**
 * Is this the `accounting_events` `@@unique([externalSystem, externalId])` violation — i.e. the
 * statement tried to claim an external document id that another event row already holds?
 *
 * Verified live against `onetwo3d_ims_dev` (rolled back), Prisma + `@prisma/adapter-pg` 7.7.0,
 * by setting `externalId` on a second event to a value an existing row already carried:
 *
 *   code: 'P2002'
 *   meta.modelName: 'AccountingEvent'
 *   meta.driverAdapterError.cause: {
 *     originalCode: '23505',
 *     originalMessage: 'duplicate key value violates unique constraint
 *                       "accounting_events_externalSystem_externalId_key"',
 *     kind: 'UniqueConstraintViolation',
 *     constraint: { fields: ['"externalSystem"', '"externalId"'] },
 *   }
 *   meta.target: undefined
 *
 * `externalId` alone is the discriminator: it is the only field the composite index shares with
 * no other unique constraint on the table (the other is `idempotencyKey`), and the constraint-name
 * fallback `accounting_events_externalSystem_externalId_key` is suffix-matched by the same reader.
 */
export function isExternalAccountingReferenceUniqueError(error: unknown): boolean {
  return uniqueViolationTargetsField(error, 'externalId')
}
