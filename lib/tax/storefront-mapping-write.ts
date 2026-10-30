/**
 * THE ONE WAY TO CHANGE A STOREFRONT TAX-RATE MAPPING ROW WITHOUT KEEPING AN OWNERSHIP STAMP IT NO LONGER EARNS.
 *
 * A mapping row of the storefront connector may carry `storeIdentity`: the stamp the operator's adoption step (or the tax-rate writer itself) put there to say "this WooCommerce rate id, in this
 * store, is this IMS rate, and it was this rate when I looked" (lib/connectors/woocommerce/tax-rate-plan.ts, THE OWNERSHIP RULE). The stamp is only worth anything while the row still says
 * what it was stamped for. So every writer that changes a stamped row's mapped IMS rate (`taxRateId`) or any identity snapshot field (name, country, percent, class: `sameRateIdentity`)
 * CLEARS the stamp IN THE SAME WRITE, and the row counts as MAPPING_NOT_ADOPTED until the operator re-adopts it. A write that changes nothing of that keeps the stamp; a row it creates is born
 * unstamped. (Without this an owner who replaces WooCommerce rate 10 by another and imports would get a still-stamped row with a fresh snapshot, and the planner could delete rate 10.)
 *
 * The row is locked FOR UPDATE for the read-decide-write, so an adoption that stamps it concurrently waits and then sees what was written. The census
 * (tests/tax/storefront-mapping-writers-census.test.ts) lists every writer of the table and fails on one that does not use this or clear the stamp itself.
 */

import type { Prisma } from '@/app/generated/prisma/client'

import { identityOfMapping, sameRateIdentity } from '@/lib/connectors/woocommerce/tax-rate-plan'

export type StorefrontMappingFields = {
  externalName: string
  externalCountry: string | null
  /** Percent as text. */
  externalRatePct: string
  externalClass: string | null
  taxRateId: string
}

export type StorefrontMappingClient = Pick<Prisma.TransactionClient, 'shoppingTaxRateMapping' | '$queryRaw'>

type Stamped = StorefrontMappingFields & { storeIdentity: string | null }

/** Whether a stamped row still means what it was stamped for after `merged` replaces `existing`: same IMS rate, same four identity fields. */
export function mappingKeepsStamp(existing: StorefrontMappingFields, merged: StorefrontMappingFields): boolean {
  const asRow = (f: StorefrontMappingFields) => ({ externalTaxRateId: '', storeIdentity: null, ...f })
  return existing.taxRateId === merged.taxRateId && sameRateIdentity(identityOfMapping(asRow(existing)), identityOfMapping(asRow(merged)))
}

/**
 * Writes the mapping row of (connector, externalTaxRateId). A missing row is created from `create` (unstamped), or, when `create` is null, the write fails like an update of nothing. A present row
 * gets `patch`, and keeps its stamp only if the result still means the same (see above); otherwise the stamp is cleared in this same update. Returns whether a stamp was cleared.
 */
export async function writeStorefrontTaxMapping(
  tx: StorefrontMappingClient,
  key: { connector: string; externalTaxRateId: string },
  patch: Partial<StorefrontMappingFields>,
  create: StorefrontMappingFields | null,
): Promise<{ created: boolean; stampCleared: boolean }> {
  await tx.$queryRaw`SELECT id FROM shopping_tax_rate_mappings WHERE connector = ${key.connector} AND "externalTaxRateId" = ${key.externalTaxRateId} FOR UPDATE`
  const row = await tx.shoppingTaxRateMapping.findUnique({
    where: { connector_externalTaxRateId: key },
    select: { externalName: true, externalCountry: true, externalRatePct: true, externalClass: true, taxRateId: true, storeIdentity: true },
  })
  const where = { connector_externalTaxRateId: key }
  if (row === null) {
    if (create === null) throw new Error(`no storefront tax-rate mapping for ${key.connector} rate ${key.externalTaxRateId}`)
    await tx.shoppingTaxRateMapping.upsert({ where, create: { ...key, ...create }, update: { ...create } })
    return { created: true, stampCleared: false }
  }
  const existing: Stamped = { ...row, externalRatePct: row.externalRatePct.toFixed(4) }
  const merged: StorefrontMappingFields = { ...existing, ...patch }
  const keep = existing.storeIdentity !== null && mappingKeepsStamp(existing, merged)
  await tx.shoppingTaxRateMapping.update({ where, data: { ...patch, storeIdentity: keep ? existing.storeIdentity : null } })
  return { created: false, stampCleared: existing.storeIdentity !== null && !keep }
}
