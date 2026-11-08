import { Prisma } from '@/app/generated/prisma/client'

/**
 * The key names a warehouse return record may carry its id and its order reference under. Shared by the connector's normaliser and by the erasure's
 * find-rows-by-subject step, so the two cannot disagree about which raw key holds which value.
 */
export const RETURN_ID_KEYS = ['returnId', 'ReturnId', 'externalReturnId', 'ExternalReturnId', 'id', 'Id', 'ID']
export const RETURN_ORDER_REFERENCE_KEYS = ['orderReference', 'OrderReference', 'orderNumber', 'OrderNumber', 'externalOrderNumber', 'ExternalOrderNumber', 'reference', 'Reference']

const text = (ids: string[]) => Prisma.sql`${ids}::text[]`

function returnLogWhere(returnIds: string[], orderRefs: string[]): Prisma.Sql {
  return Prisma.sql`j."type" = 'RETURNS_SYNC' AND l."payload" IS NOT NULL AND l."payload" <> '{}'::jsonb AND jsonb_typeof(l."payload") = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_each_text(l."payload") e
                 WHERE (e.key = ANY(${RETURN_ID_KEYS}::text[]) AND e.value = ANY(${text(returnIds)}))
                    OR (e.key = ANY(${RETURN_ORDER_REFERENCE_KEYS}::text[]) AND e.value = ANY(${text(orderRefs)})))`
}

/**
 * Clears (to {}) the sync-log rows of returns jobs whose RAW warehouse record names one of these return ids or order references under the keys the normaliser
 * reads them from, and throws when one is left. Rows written before the returns sync stopped copying the raw record into its log. Returns the rows cleared.
 */
export async function clearRawReturnLogs(tx: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, returnIds: string[], orderRefs: string[]): Promise<number> {
  const cleared = Number(await tx.$executeRaw`
    UPDATE "wms_sync_logs" l SET "payload" = '{}'::jsonb FROM "wms_sync_jobs" j
     WHERE j."id" = l."jobId" AND ${returnLogWhere(returnIds, orderRefs)}`)
  const left = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "wms_sync_logs" l JOIN "wms_sync_jobs" j ON j."id" = l."jobId" WHERE ${returnLogWhere(returnIds, orderRefs)}`
  if (Number(left[0]?.n ?? 0) > 0) throw new Error('Raw return record clearing incomplete')
  return cleared
}
