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

/**
 * The provenance string for an id a KNOWN connection issued (o3d-gfh).
 *
 * The same `"<connector>:<tenantId>"` shape `activeAccountingIdProvenance` produces, built from a tenant
 * the caller already holds instead of from another read of the token row. It exists so that the tenant
 * an id was ISSUED BY can be stamped rather than the tenant that happens to be connected once the call
 * has returned: those are the same value except in exactly the case provenance exists to catch, and the
 * resample silently prefers the wrong one. Callers get the issuing tenant from `XeroResponse.tenantId`,
 * which is the id that went out in the request's own `Xero-Tenant-Id` header.
 *
 * Returns null for a blank/absent tenant, so "no request was made" cannot be stamped as a provenance —
 * a null column re-resolves on the next read, which is the safe direction.
 */
export function accountingIdProvenanceFor(connector: string, tenantId: string | null | undefined): string | null {
  const tenant = (tenantId ?? '').trim()
  return tenant ? `${connector}:${tenant}` : null
}

/**
 * The provenance string for a connector's currently-connected tenant/realm, or `null` when that connector
 * has no token (so nothing can legitimately match — a stored id is treated as stale).
 */
export async function activeAccountingIdProvenance(connector: string): Promise<string | null> {
  // Imported HERE rather than at module scope so that the two PURE functions in this file —
  // `accountingIdProvenanceFor` and `accountingIdProvenanceMatches` — can be reached without
  // constructing a Prisma client. `lib/domain/accounting/followup-idempotency.ts` is a pure planner
  // whose whole point is being decidable without a database, and it now needs the connection
  // comparison; a static `import { db }` here would drag Prisma into it and into its tests.
  const { db } = await import('@/lib/db')
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
