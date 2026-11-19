/**
 * CUSTOMER CLUSTERS (CRM foundation): which Customer rows are the same person.
 *
 * NOTHING IS MERGED IN THE DATABASE. A cluster is computed on read, over the original rows, from two inputs:
 *
 *   1. THE DERIVED RULE (owner decisions 2026-11-18 and 2026-11-19): two customers are the same person when their emails are equal after the identity fold
 *      (lib/domain/crm/identity-key.ts `looseIdentityEmail`: case, whitespace, +tag, and Gmail/Googlemail dots), unless either is anonymised. The storefront
 *      customer id plays NO part: WooCommerce cannot hold one email on two accounts, so two accounts whose emails differ only by an alias ARE one person.
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

/** True when the DERIVED rule alone joins the pair (both live, same folded email). */
export function derivedLink(a: ClusterCustomer, b: ClusterCustomer): boolean {
  if (a.id === b.id || a.anonymised || b.anonymised) return false
  const ka = looseIdentityEmail(a.email)
  return ka !== null && ka === looseIdentityEmail(b.email)
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
 * THE SQL TWIN OF looseIdentityEmail, used to find CANDIDATES (every candidate is re-filtered in TypeScript, which also rejects placeholder addresses). It is
 * the database function crm_loose_identity_key (migration 20261119140100): NFC, trim of every JavaScript white-space character, ASCII lower-case under the "C"
 * collation, the +tag and Gmail dots folded. The partial index customers_loose_identity_key_v2_idx is on the same call, which makes the lookup an index probe,
 * and tests/db/crm-identity.test.ts holds the two implementations to the same answers on whitespace, NFC/NFD and non-ASCII samples.
 */
export const CUSTOMER_LOOSE_EMAIL_KEY_SQL = Prisma.sql`crm_loose_identity_key("email")`

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'customer' | 'customerMergeEvent'>

export interface ClusterInputs {
  customers: ClusterCustomer[]
  decisions: OperatorDecision[]
  /** True when the walk stopped at MAX_CLUSTER_MEMBERS: the cluster shown is a prefix of a larger one. */
  truncated: boolean
}

async function readCustomers(db: Reader, ids: string[]): Promise<ClusterCustomer[]> {
  if (ids.length === 0) return []
  const rows = await db.customer.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, gdprAnonymisedAt: true } })
  return rows.map((r) => ({ id: r.id, email: r.email, anonymised: r.gdprAnonymisedAt !== null }))
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

/**
 * THE ORDER A CLUSTER IS ERASED IN: members that hold the cluster together ("linking" members: removing one would disconnect others, such as a record joined
 * to two storefront accounts, or the middle of a chain) go LAST, and the customer the request was made for goes at the very end. Erasing a linking member early
 * is what used to cut the rest of the cluster off from a re-run. The saved member list (customer_cluster_erasures) is what actually makes a re-run complete; this
 * order only keeps the cluster intact for as long as possible, so a failure leaves as much as possible still reachable.
 */
export function erasureOrder(seedId: string, ids: ReadonlyArray<string>, customers: ReadonlyArray<ClusterCustomer>, decisions: ReadonlyArray<OperatorDecision>): string[] {
  const byId = new Map(customers.map((c) => [c.id, c]))
  const newest = newestOperatorDecisions(decisions)
  const members = ids.filter((id) => byId.has(id))
  const adjacent = (a: string, b: string) => effectiveLink(byId.get(a)!, byId.get(b)!, newest.get(pairKey(a, b)))
  const connectedWithout = (removed: string): boolean => {
    const rest = members.filter((id) => id !== removed)
    if (rest.length <= 1) return true
    const seen = new Set([rest[0]!])
    const queue = [rest[0]!]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const other of rest) if (!seen.has(other) && adjacent(current, other)) { seen.add(other); queue.push(other) }
    }
    return seen.size === rest.length
  }
  const linking = new Set(members.filter((id) => id !== seedId && !connectedWithout(id)))
  const sorted = [...ids].sort()
  return [
    ...sorted.filter((id) => id !== seedId && !linking.has(id)),
    ...sorted.filter((id) => id !== seedId && linking.has(id)),
    ...(ids.includes(seedId) ? [seedId] : []),
  ]
}

/** The cluster of `customerId` with the order to erase it in (see erasureOrder). */
export async function clusterForErasure(db: Reader, customerId: string): Promise<{ ids: string[]; order: string[]; truncated: boolean }> {
  const inputs = await loadClusterInputs(db, customerId)
  const ids = resolveCluster(customerId, inputs.customers, inputs.decisions)
  return { ids, order: erasureOrder(customerId, ids, inputs.customers, inputs.decisions), truncated: inputs.truncated }
}
