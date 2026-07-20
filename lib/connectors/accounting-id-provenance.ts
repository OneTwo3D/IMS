/**
 * Provenance for cached accounting ids (o3d-6nd).
 *
 * `Product.accountingItemId` and `Customer`/`Supplier.accountingContactId` cache an id owned by whichever
 * accounting connector is connected. The per-invoice lookups short-circuit on the stored id so they never
 * re-verify it — which is the whole point, but it means a stale id (from a connector switch that bypassed
 * disconnect, or a re-authorisation to a different Xero org) would be read by a connection that never
 * issued it. QuickBooks ids are numeric strings and Xero ids are UUIDs, so today the failure is a loud
 * broken sync rather than corrupted books — but it is still a failure, and the guard below removes it.
 *
 * Provenance is `"<connector>:<tenantId>"`, taken from the connection's `AccountingToken` row (QuickBooks
 * stores its realmId in the same `tenantId` column). Storing it beside the id lets a reader ignore an id
 * whose provenance does not match the active connection, so correctness no longer depends on every exit
 * path remembering to clear the column.
 */

import { db } from '@/lib/db'

/**
 * The provenance string for a connector's currently-connected tenant/realm, or `null` when that connector
 * has no token (so nothing can legitimately match — a stored id is treated as stale).
 */
export async function activeAccountingIdProvenance(connector: string): Promise<string | null> {
  const token = await db.accountingToken.findUnique({
    where: { connector },
    select: { tenantId: true },
  })
  return token ? `${connector}:${token.tenantId}` : null
}

/**
 * May an id stored with `storedProvenance` be trusted for the connection identified by `activeProvenance`?
 *
 * Deliberately strict: only an EXACT match passes. A NULL stored provenance (a legacy id cached before
 * this column existed) never matches, so it re-resolves once and stamps its own provenance — the intended
 * self-backfill. A NULL active provenance (no live token) never matches either.
 */
export function accountingIdProvenanceMatches(
  storedProvenance: string | null,
  activeProvenance: string | null,
): boolean {
  return activeProvenance !== null && storedProvenance === activeProvenance
}
