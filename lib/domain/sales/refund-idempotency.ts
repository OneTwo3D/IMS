import { Prisma } from '@/app/generated/prisma/client'

import { uniqueViolationTargetsField } from '@/lib/db/prisma-unique-violation'

/**
 * Is this the `sales_order_refunds.externalRefundId` unique violation — i.e. the connector
 * refund this request carries has already been turned into an IMS refund?
 *
 * o3d-5od: this used to read `error.meta.target` only, which the pg driver adapter never
 * populates, so a duplicate WooCommerce refund delivery surfaced as a hard failure instead
 * of being deduped. See lib/db/prisma-unique-violation.ts.
 *
 * Still deliberately narrow: `externalRefundIdHash` or a `tenantExternalRefundIdKey`-style
 * constraint must NOT match, so the field name is matched exactly (or as the column inside
 * Postgres' default `<table>_externalRefundId_key` constraint name), never as a substring.
 */
export function isExternalRefundIdUniqueConflict(error: unknown): boolean {
  return uniqueViolationTargetsField(error, 'externalRefundId')
}

/** Any Prisma unique-constraint violation (P2002), regardless of which index. (o3d-7yf) */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}
