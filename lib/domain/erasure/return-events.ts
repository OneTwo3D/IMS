import { Prisma } from '@/app/generated/prisma/client'

/**
 * The return_inbox MUTATION EVENTS copy the free-text reason (and any resolution note) of a returns-inbox row into their before / after JSON. They are found
 * by the inbox row ids and their free-text keys are replaced with the marker, set-based; null stays null and other keys are untouched. Returns the rows changed.
 */
// A row is dirty while either JSON still differs from its projection (a free-text value not yet the marker, or ANY key the projection would drop).
const DIRTY = Prisma.sql`(e."before" IS DISTINCT FROM gdpr_project_return_event(e."before") OR e."after" IS DISTINCT FROM gdpr_project_return_event(e."after"))`

export async function scrubReturnInboxEvents(tx: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, inboxIds: string[]): Promise<number> {
  const changed = Number(await tx.$executeRaw`
        UPDATE "wms_mutation_events" e
           SET "before" = gdpr_project_return_event(e."before"), "after" = gdpr_project_return_event(e."after")
         WHERE e."entityType" = 'RETURN' AND e."action" = 'return_inbox' AND e."entityId" = ANY(${inboxIds}::text[]) AND ${DIRTY}`)
  const left = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "wms_mutation_events" e WHERE e."entityType" = 'RETURN' AND e."action" = 'return_inbox' AND e."entityId" = ANY(${inboxIds}::text[]) AND ${DIRTY}`
  if (Number(left[0]?.n ?? 0) > 0) throw new Error('Return event scrubbing incomplete')
  return changed
}
