import { db } from '@/lib/db'
import { GUARDED_FREE_TEXT, sqlColumn } from './free-text-guard'

const MARKER = 'Text removed by GDPR erasure'

/**
 * Clears guarded free text on rows of ERASED orders that the erasure and the triggers did not see: a row inserted while an erasure was still
 * uncommitted. Idempotent; runs from the email-outbox cron after each drain. Table and column names come from the constant list, never from input.
 */
export async function reconcileErasedFreeText(): Promise<number> {
  let changed = 0
  for (const guard of GUARDED_FREE_TEXT) {
    const sets = [
      ...guard.columns.map((c) => `"${sqlColumn(guard, c)}" = '${MARKER}'`),
      ...(guard.jsonColumns ?? []).map((c) => `"${sqlColumn(guard, c)}" = '{}'::jsonb`),
    ].join(', ')
    const dirty = [
      ...guard.columns.map((c) => `(t."${sqlColumn(guard, c)}" IS NOT NULL AND t."${sqlColumn(guard, c)}" <> '${MARKER}')`),
      ...(guard.jsonColumns ?? []).map((c) => `(t."${sqlColumn(guard, c)}" IS NOT NULL AND t."${sqlColumn(guard, c)}" <> '{}'::jsonb)`),
    ].join(' OR ')
    changed += Number(await db.$executeRawUnsafe(
      `UPDATE "${guard.table}" t SET ${sets} FROM "sales_orders" o LEFT JOIN "customers" c ON c."id" = o."customerId"
        WHERE t."${guard.orderIdColumn}" = o."id" AND (o."erasedAt" IS NOT NULL OR c."gdprAnonymisedAt" IS NOT NULL) AND (${dirty})`,
    ))
  }
  return changed
}
