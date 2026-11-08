import type { Prisma } from '@/app/generated/prisma/client'

/** The one identity-free marker written where a free-text column HAD a value (the same string as ERASED_FREE_TEXT_MARKER in erase-personal-data.ts). */
const ERASED_FREE_TEXT_MARKER = 'Text removed by GDPR erasure'

/**
 * The return_inbox MUTATION EVENTS copy the free-text reason (and any resolution note) of a returns-inbox row into their before / after JSON. They are found
 * by the inbox row ids and their free-text keys are replaced with the marker, set-based; null stays null and other keys are untouched. Returns the rows changed.
 */
export async function scrubReturnInboxEvents(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, inboxIds: string[]): Promise<number> {
  return Number(await tx.$executeRaw`
        UPDATE "wms_mutation_events" e
           SET "before" = CASE WHEN e."before" IS NULL THEN NULL ELSE
                 e."before" || (CASE WHEN (e."before"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END)
                            || (CASE WHEN (e."before"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END) END,
               "after" = CASE WHEN e."after" IS NULL THEN NULL ELSE
                 e."after" || (CASE WHEN (e."after"->>'reason') IS NOT NULL THEN jsonb_build_object('reason', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END)
                           || (CASE WHEN (e."after"->>'resolutionNote') IS NOT NULL THEN jsonb_build_object('resolutionNote', ${ERASED_FREE_TEXT_MARKER}::text) ELSE '{}'::jsonb END) END
         WHERE e."entityType" = 'RETURN' AND e."action" = 'return_inbox' AND e."entityId" = ANY(${inboxIds}::text[])
           AND ((e."before"->>'reason') IS DISTINCT FROM ${ERASED_FREE_TEXT_MARKER}::text OR (e."after"->>'reason') IS DISTINCT FROM ${ERASED_FREE_TEXT_MARKER}::text)
           AND ((e."before"->>'reason') IS NOT NULL OR (e."after"->>'reason') IS NOT NULL OR (e."before"->>'resolutionNote') IS NOT NULL OR (e."after"->>'resolutionNote') IS NOT NULL)`)
}
