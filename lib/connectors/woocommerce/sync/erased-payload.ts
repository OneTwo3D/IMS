import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import type { WcFullOrder } from './types'

/**
 * The ALLOWLIST PROJECTION of a storefront order (migration erasure_raw_payload_projection, `gdpr_project_wc_order`): the one implementation that the erasure,
 * the guard triggers and now the importer share. An order created already erased is mapped from this, so no free-text field of the original (an item or fee
 * name, the gateway transaction id, a personalised value) reaches a line, a fee or a payment. Ids, quantities, money, tax lines and totals are kept exactly.
 */
export async function projectWcOrderForErasure<T extends Pick<WcFullOrder, 'id'>>(order: T, client: Prisma.TransactionClient | typeof db = db): Promise<T> {
  const rows = await client.$queryRaw<Array<{ p: T }>>`SELECT gdpr_project_wc_order(${JSON.stringify(order)}::jsonb) AS p`
  return rows[0]?.p ?? order
}
