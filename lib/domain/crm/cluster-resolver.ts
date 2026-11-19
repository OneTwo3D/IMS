/**
 * CUSTOMER CLUSTERS (CRM foundation): which Customer rows are the same person.
 *
 * NOTHING IS MERGED IN THE DATABASE. A cluster is computed on read, over the original rows, from two inputs:
 *
 *   1. THE DERIVED RULE (owner decision 2026-11-18): two customers are the same person when their emails are equal after the identity fold
 *      (lib/domain/crm/identity-key.ts `looseIdentityEmail`: case, whitespace, +tag, and Gmail/Googlemail dots), UNLESS both carry storefront ids and
 *      share none (two different storefront accounts are two people), or either is anonymised.
 *   2. THE OPERATOR OVERRIDE: for a pair, the NEWEST OPERATOR row in customer_merge_events decides. MERGE joins the pair whatever the email says;
 *      UNMERGE separates them whatever the email says. AUTO_EMAIL rows are audit only and are never read here, so a stale auto row can not keep
 *      two customers joined after their emails stop matching.
 *
 * A cluster is the connected component of those pair links that contains the customer asked about. An anonymised (erased) customer is never in a
 * live cluster, and an operator row naming one is inert.
 *
 * `resolveCluster` is pure; `loadClusterInputs` reads the minimum needed and every read is bounded (MAX_CLUSTER_MEMBERS).
 */
import { Prisma } from '@/app/generated/prisma/client'
import { looseIdentityEmail } from '@/lib/domain/crm/identity-key'

export const MAX_CLUSTER_MEMBERS = 200

export interface ClusterCustomer {
  id: string
  email: string | null
  /** Every storefront customer id the customer is known by: its own integer, its storefront links, and the id stored on each of its orders. */
  storefrontIds: ReadonlyArray<string>
  anonymised: boolean
}

export interface OperatorDecision {
  customerId: string
  otherCustomerId: string
  kind: 'MERGE' | 'UNMERGE'
  seq: bigint
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** The newest OPERATOR decision of each pair. Input order does not matter. */
export function newestOperatorDecisions(rows: ReadonlyArray<OperatorDecision>): Map<string, OperatorDecision> {
  const out = new Map<string, OperatorDecision>()
  for (const row of rows) {
    const key = pairKey(row.customerId, row.otherCustomerId)
    const current = out.get(key)
    if (!current || row.seq > current.seq) out.set(key, row)
  }
  return out
}

/** Two customers carry storefront ids and none is shared: two accounts, so two people (the derived rule never joins them). */
export function storefrontIdsConflict(a: ClusterCustomer, b: ClusterCustomer): boolean {
  if (a.storefrontIds.length === 0 || b.storefrontIds.length === 0) return false
  const theirs = new Set(b.storefrontIds)
  return !a.storefrontIds.some((id) => theirs.has(id))
}

/** True when the DERIVED rule alone joins the pair (both live, same folded email, no storefront-account conflict). */
export function derivedLink(a: ClusterCustomer, b: ClusterCustomer): boolean {
  if (a.id === b.id || a.anonymised || b.anonymised) return false
  const ka = looseIdentityEmail(a.email)
  if (ka === null || ka !== looseIdentityEmail(b.email)) return false
  return !storefrontIdsConflict(a, b)
}

/** True when the pair is linked once the operator decision (if any) is applied. */
export function effectiveLink(a: ClusterCustomer, b: ClusterCustomer, decision: OperatorDecision | undefined): boolean {
  if (a.id === b.id || a.anonymised || b.anonymised) return false
  if (decision) return decision.kind === 'MERGE'
  return derivedLink(a, b)
}

/** The ids of the cluster that contains `seedId`, sorted. An anonymised or unknown seed is a cluster of itself only (it is never joined to anyone). */
export function resolveCluster(seedId: string, customers: ReadonlyArray<ClusterCustomer>, decisions: ReadonlyArray<OperatorDecision>): string[] {
  const byId = new Map(customers.map((c) => [c.id, c]))
  const seed = byId.get(seedId)
  if (!seed || seed.anonymised) return [seedId]
  const newest = newestOperatorDecisions(decisions)
  const seen = new Set([seedId])
  const queue = [seed]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const other of customers) {
      if (seen.has(other.id)) continue
      if (effectiveLink(current, other, newest.get(pairKey(current.id, other.id)))) {
        seen.add(other.id)
        queue.push(other)
      }
    }
  }
  return [...seen].sort()
}

/**
 * THE SQL TWIN OF looseIdentityEmail, used only to find CANDIDATES (the result is re-filtered in TypeScript, so a difference can only cost a missed
 * candidate for an exotic address, never a wrong join). It is byte-for-byte the expression of the partial index
 * customers_identity_key_idx (migration 20261119131200), which is what makes the lookup an index probe; tests/db/crm-identity.test.ts holds the two
 * implementations to the same answers.
 */
export const CUSTOMER_LOOSE_EMAIL_KEY_SQL = Prisma.sql`(
  CASE
    WHEN split_part(lower(btrim("email")), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(lower(btrim("email")), '@', 1), '+', 1), '.', '') || '@gmail.com'
    ELSE split_part(split_part(lower(btrim("email")), '@', 1), '+', 1) || '@' || split_part(lower(btrim("email")), '@', 2)
  END
)`

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'customer' | 'customerMergeEvent'>

export interface ClusterInputs {
  customers: ClusterCustomer[]
  decisions: OperatorDecision[]
  /** True when the walk stopped at MAX_CLUSTER_MEMBERS: the cluster shown is a prefix of a larger one. */
  truncated: boolean
}

async function readCustomers(db: Reader, ids: string[]): Promise<ClusterCustomer[]> {
  if (ids.length === 0) return []
  const rows = await db.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, externalCustomerId: true, gdprAnonymisedAt: true, shoppingLinks: { select: { externalCustomerId: true } } },
  })
  const orderIds = await db.$queryRaw<Array<{ customerId: string; external_customer_id: number }>>`
    SELECT DISTINCT "customerId", "external_customer_id" FROM "sales_orders"
    WHERE "customerId" IN (${Prisma.join(ids)}) AND "external_customer_id" IS NOT NULL`
  const fromOrders = new Map<string, string[]>()
  for (const r of orderIds) fromOrders.set(r.customerId, [...(fromOrders.get(r.customerId) ?? []), String(r.external_customer_id)])
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    anonymised: r.gdprAnonymisedAt !== null,
    storefrontIds: [...new Set([...(r.externalCustomerId != null ? [String(r.externalCustomerId)] : []), ...r.shoppingLinks.map((l) => l.externalCustomerId), ...(fromOrders.get(r.id) ?? [])])],
  }))
}

/** Read the customers and operator decisions needed to resolve the cluster of `seedId`: expand by shared email key and by operator rows until nothing new appears. */
export async function loadClusterInputs(db: Reader, seedId: string): Promise<ClusterInputs> {
  const known = new Map<string, ClusterCustomer>()
  const decisions = new Map<string, OperatorDecision>()
  let frontier = [seedId]
  let truncated = false
  while (frontier.length > 0) {
    const fresh = (await readCustomers(db, frontier.filter((id) => !known.has(id))))
    for (const c of fresh) known.set(c.id, c)
    const keys = [...new Set(fresh.filter((c) => !c.anonymised).map((c) => looseIdentityEmail(c.email)).filter((k): k is string => k !== null))]
    const next = new Set<string>()
    if (keys.length > 0) {
      const peers = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "customers"
        WHERE "email" IS NOT NULL AND "gdprAnonymisedAt" IS NULL AND ${CUSTOMER_LOOSE_EMAIL_KEY_SQL} = ANY(${keys}::text[])
        LIMIT ${MAX_CLUSTER_MEMBERS + 1}`
      for (const p of peers) next.add(p.id)
    }
    const frontierIds = fresh.map((c) => c.id)
    const events = await db.customerMergeEvent.findMany({
      where: { source: 'OPERATOR', OR: [{ customerId: { in: frontierIds } }, { otherCustomerId: { in: frontierIds } }] },
      select: { customerId: true, otherCustomerId: true, kind: true, seq: true },
    })
    for (const e of events) {
      decisions.set(`${e.seq}`, { customerId: e.customerId, otherCustomerId: e.otherCustomerId, kind: e.kind, seq: e.seq })
      next.add(e.customerId)
      next.add(e.otherCustomerId)
    }
    frontier = [...next].filter((id) => !known.has(id))
    if (known.size + frontier.length > MAX_CLUSTER_MEMBERS) {
      truncated = true
      frontier = frontier.slice(0, Math.max(0, MAX_CLUSTER_MEMBERS - known.size))
    }
  }
  return { customers: [...known.values()], decisions: [...decisions.values()], truncated }
}

/** The ids of the cluster containing `customerId` (always includes it), sorted, plus whether the walk was cut short. */
export async function clusterOf(db: Reader, customerId: string): Promise<{ ids: string[]; truncated: boolean }> {
  const inputs = await loadClusterInputs(db, customerId)
  return { ids: resolveCluster(customerId, inputs.customers, inputs.decisions), truncated: inputs.truncated }
}
