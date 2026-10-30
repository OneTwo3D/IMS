/**
 * THE ONE WAY TO CHANGE A STOREFRONT TAX-RATE MAPPING ROW WITHOUT KEEPING AN OWNERSHIP STAMP IT NO LONGER EARNS.
 *
 * A mapping row of the storefront connector may carry `storeIdentity`: the stamp the operator's adoption step (or the tax-rate writer itself) put there to say "this WooCommerce rate id, in this
 * store, is this IMS rate, and it was this rate when I looked" (lib/connectors/woocommerce/tax-rate-plan.ts, THE OWNERSHIP RULE). The stamp is only worth anything while the row still says
 * what it was stamped for. So every writer that changes a stamped row's mapped IMS rate (`taxRateId`) or any identity snapshot field (name, country, percent, class: `sameRateIdentity`)
 * CLEARS the stamp IN THE SAME WRITE, and the row counts as MAPPING_NOT_ADOPTED until the operator re-adopts it. A write that changes nothing of that keeps the stamp; a row it creates is born
 * unstamped. (Without this an owner who replaces WooCommerce rate 10 by another and imports would get a still-stamped row with a fresh snapshot, and the planner could delete rate 10.)
 *
 * THE DECISION IS MADE BY THE DATABASE, IN THE WRITE ITSELF, never from a row read earlier: the upsert is ONE `INSERT ... ON CONFLICT DO UPDATE` whose `store_identity` is
 * `CASE WHEN <the row as it is when the update runs still means what it was stamped for> THEN <its stamp> ELSE NULL END`, and the re-point is one `UPDATE` with the same shape. PostgreSQL locks
 * the row at the conflict and evaluates the CASE against its latest committed version, so a row another transaction creates and adopts (or re-points) first is judged as that transaction left it.
 * The CASE guards the stamp against every writer (it needs nothing from them); the shared apply lock (lockStorefrontMappingWrites) is a second, separate thing: it keeps writers out of a
 * RUNNING APPLY, whose send cannot be undone, and the census requires every writer to take it. The absent row needs no special case (a created row is unstamped; a row that appears meanwhile hits the conflict branch and is judged by the CASE).
 * The SQL comparison mirrors `sameRateIdentity` (R13's comparisons) and is stricter in every case it differs from it (it can only clear more); a differential test pins that.
 *
 * The census (tests/tax/storefront-mapping-writers-census.test.ts) lists every writer of the table and fails on one that does not use this or clear the stamp itself.
 */

import { Prisma } from '@/app/generated/prisma/client'

import { WOO_TAX_RATE_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { identityOfMapping, sameRateIdentity } from '@/lib/connectors/woocommerce/tax-rate-plan'

export type StorefrontMappingFields = {
  externalName: string
  externalCountry: string | null
  /** Percent as text. */
  externalRatePct: string
  externalClass: string | null
  taxRateId: string
}

export type StorefrontMappingClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>

/**
 * THE APPLY LOCK, TAKEN BY EVERY WRITER OF THE TABLE. The tax-rate writer's apply holds WOO_TAX_RATE_WRITE_LOCK_KEY exclusively for its whole run and re-reads the ownership it rests on
 * immediately before each send; this takes the same key SHARED until the caller's transaction ends, so no mapping write can land between that re-read and the send. Call it as the FIRST
 * statement of the transaction (before any row lock, so a waiting writer holds nothing the apply needs). `tx` must be a real transaction: outside one the lock is released at once.
 */
export async function lockStorefrontMappingWrites(tx: Pick<StorefrontMappingClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${WOO_TAX_RATE_WRITE_LOCK_KEY}::bigint)`
}

/** Whether a stamped row still means what it was stamped for after `merged` replaces `existing`: same IMS rate, same four identity fields. (The SQL below is the same rule.) */
export function mappingKeepsStamp(existing: StorefrontMappingFields, merged: StorefrontMappingFields): boolean {
  const asRow = (f: StorefrontMappingFields) => ({ externalTaxRateId: '', storeIdentity: null, ...f })
  return existing.taxRateId === merged.taxRateId && sameRateIdentity(identityOfMapping(asRow(existing)), identityOfMapping(asRow(merged)))
}

const T = Prisma.raw('shopping_tax_rate_mappings')
const norm = (column: Prisma.Sql) => Prisma.sql`lower(regexp_replace(regexp_replace(${column}, '^\\s+|\\s+$', '', 'g'), '\\s+', ' ', 'g'))`
const country = (column: Prisma.Sql) => Prisma.sql`(CASE upper(regexp_replace(coalesce(${column}, ''), '^\\s+|\\s+$', '', 'g')) WHEN 'UK' THEN 'GB' WHEN 'EL' THEN 'GR' ELSE upper(regexp_replace(coalesce(${column}, ''), '^\\s+|\\s+$', '', 'g')) END)`
const klass = (column: Prisma.Sql) => Prisma.sql`(CASE WHEN regexp_replace(coalesce(${column}, ''), '^\\s+|\\s+$', '', 'g') = '' THEN 'standard' ELSE lower(regexp_replace(${column}, '^\\s+|\\s+$', '', 'g')) END)`

/** SQL: the row (`old`) still means what it was stamped for after being replaced by `incoming` (the same IMS rate and name, country, percent and class all equal as R13 compares them). */
function sameMeaning(old: (c: string) => Prisma.Sql, incoming: (c: string) => Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${old('"taxRateId"')} = ${incoming('"taxRateId"')}
    AND ${norm(old('"externalName"'))} = ${norm(incoming('"externalName"'))}
    AND ${country(old('"externalCountry"'))} = ${country(incoming('"externalCountry"'))}
    AND ${old('"externalRatePct"')} = ${incoming('"externalRatePct"')}
    AND ${klass(old('"externalClass"'))} = ${klass(incoming('"externalClass"'))})`
}
const oldCol = (c: string) => Prisma.sql`${T}.${Prisma.raw(c)}`
const newCol = (c: string) => Prisma.sql`EXCLUDED.${Prisma.raw(c)}`

/**
 * Creates the mapping row of (connector, externalTaxRateId) from `fields`, or overwrites it. A created row is unstamped. An existing row keeps its stamp only if the overwrite changes nothing
 * of what it was stamped for; otherwise the stamp is cleared by this same statement.
 */
export async function upsertStorefrontTaxMapping(
  tx: StorefrontMappingClient,
  key: { connector: string; externalTaxRateId: string },
  fields: StorefrontMappingFields,
): Promise<{ created: boolean }> {
  await lockStorefrontMappingWrites(tx)
  const rows = await tx.$queryRaw<Array<{ created: boolean }>>(Prisma.sql`
    INSERT INTO ${T} (id, connector, "externalTaxRateId", "externalName", "externalCountry", "externalRatePct", "externalClass", "taxRateId", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${key.connector}, ${key.externalTaxRateId}, ${fields.externalName}, ${fields.externalCountry}, ${fields.externalRatePct}::numeric, ${fields.externalClass}, ${fields.taxRateId}, now(), now())
    ON CONFLICT (connector, "externalTaxRateId") DO UPDATE SET
      "externalName" = EXCLUDED."externalName",
      "externalCountry" = EXCLUDED."externalCountry",
      "externalRatePct" = EXCLUDED."externalRatePct",
      "externalClass" = EXCLUDED."externalClass",
      "taxRateId" = EXCLUDED."taxRateId",
      "updatedAt" = now(),
      store_identity = CASE WHEN ${sameMeaning(oldCol, newCol)} THEN ${T}.store_identity ELSE NULL END
    RETURNING (xmax = 0) AS created`)
  return { created: rows[0]?.created === true }
}

/** Re-points the existing mapping row at another IMS rate. The row keeps its stamp only if it is the same IMS rate; otherwise the stamp is cleared by this same statement. No such row is an error. */
export async function repointStorefrontTaxMapping(
  tx: StorefrontMappingClient,
  key: { connector: string; externalTaxRateId: string },
  taxRateId: string,
): Promise<void> {
  await lockStorefrontMappingWrites(tx)
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE ${T} SET "taxRateId" = ${taxRateId}, "updatedAt" = now(),
      store_identity = CASE WHEN "taxRateId" = ${taxRateId} THEN store_identity ELSE NULL END
    WHERE connector = ${key.connector} AND "externalTaxRateId" = ${key.externalTaxRateId}
    RETURNING id`)
  if (rows.length !== 1) throw new Error(`no storefront tax-rate mapping for ${key.connector} rate ${key.externalTaxRateId}`)
}
