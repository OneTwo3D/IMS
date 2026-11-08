import { Prisma } from '@/app/generated/prisma/client'

/** The one identity-free marker written where a free-text column HAD a value (the same string as ERASED_FREE_TEXT_MARKER in erase-personal-data.ts). */
const ERASED_FREE_TEXT_MARKER = 'Text removed by GDPR erasure'

/**
 * The return_inbox MUTATION EVENTS copy the free-text reason (and any resolution note) of a returns-inbox row into their before / after JSON. They are found
 * by the inbox row ids and their free-text keys are replaced with the marker, set-based; null stays null and other keys are untouched. Returns the rows changed.
 */
// Each of the four free-text values is checked on its own: an event with marked reasons and an unmarked note is still dirty.
const DIRTY = Prisma.sql`(
  ((e."before"->>'reason') IS NOT NULL AND (e."before"->>'reason') <> ${ERASED_FREE_TEXT_MARKER}::text)
  OR ((e."after"->>'reason') IS NOT NULL AND (e."after"->>'reason') <> ${ERASED_FREE_TEXT_MARKER}::text)
  OR ((e."before"->>'resolutionNote') IS NOT NULL AND (e."before"->>'resolutionNote') <> ${ERASED_FREE_TEXT_MARKER}::text)
  OR ((e."after"->>'resolutionNote') IS NOT NULL AND (e."after"->>'resolutionNote') <> ${ERASED_FREE_TEXT_MARKER}::text))`

export async function scrubReturnInboxEvents(tx: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, inboxIds: string[]): Promise<number> {
  const changed = Number(await tx.$executeRaw`
        UPDATE "wms_mutation_events" e
           SET "before" = CASE WHEN e."before" IS NULL THEN NULL ELSE
                 e."before" || (CASE WHEN (e."before"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END)
                            || (CASE WHEN (e."before"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END) END,
               "after" = CASE WHEN e."after" IS NULL THEN NULL ELSE
                 e."after" || (CASE WHEN (e."after"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END)
                           || (CASE WHEN (e."after"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END) END
         WHERE e."entityType" = 'RETURN' AND e."action" = 'return_inbox' AND e."entityId" = ANY(${inboxIds}::text[]) AND ${DIRTY}`)
  const left = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "wms_mutation_events" e WHERE e."entityType" = 'RETURN' AND e."action" = 'return_inbox' AND e."entityId" = ANY(${inboxIds}::text[]) AND ${DIRTY}`
  if (Number(left[0]?.n ?? 0) > 0) throw new Error('Return event scrubbing incomplete')
  return changed
}
