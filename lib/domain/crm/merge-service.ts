/**
 * CUSTOMER MERGE / UNMERGE and the auto-merge audit (CRM foundation).
 *
 * Writers of customer_merge_events, and nothing else: no Customer row, order, invoice or ledger contact is touched, and nothing is sent to WooCommerce, Xero
 * or the warehouse. The authorisation (MANAGER or ADMIN for an operator merge or unmerge) is enforced by the server action that calls this
 * (app/actions/customer-identity.ts); this module takes the already-authorised user id.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { CRM_AUTO_MERGE_AUDIT_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { lockCrmIdentity } from '@/lib/domain/crm/identity-lock'
import { clusterOf, derivedLink, loadClusterInputs, newestOperatorDecisions, pairKey, effectiveLink } from '@/lib/domain/crm/cluster-resolver'

export const CUSTOMER_MERGED_ACTION = 'customer_merged'
export const CUSTOMER_UNMERGED_ACTION = 'customer_unmerged'
const MERGED_DESCRIPTION = 'Customers merged into one person'
const UNMERGED_DESCRIPTION = 'Customer separated from its merged person'

export type MergeResult = { success: true; clusterIds: string[] } | { success: false; error: string }

const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** Merge and unmerge refuse a customer whose whole-person erasure is in flight (customer_cluster_erasures PENDING): its saved member list must not go stale. */
export const ERASURE_IN_PROGRESS_ERROR = 'An erasure of this person is in progress. Finish it (run the erasure again) before merging or separating these customers.'

async function erasureInFlight(tx: Prisma.TransactionClient, ids: string[]): Promise<boolean> {
  return (await tx.customerClusterErasure.count({ where: { status: 'PENDING', memberIds: { hasSome: ids } } })) > 0
}

async function lockPair(tx: Prisma.TransactionClient, a: string, b: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRM_AUTO_MERGE_AUDIT_LOCK_NAMESPACE}::int, hashtext(${pairKey(a, b)})::int)`
}

/** Operator MERGE of two customers. Refuses an unknown or anonymised customer, the same customer twice, and a pair that is already joined. */
export async function mergeCustomers(customerA: string, customerB: string, userId: string): Promise<MergeResult> {
  if (customerA === customerB) return { success: false, error: 'Choose two different customers' }
  return db.$transaction(async (tx): Promise<MergeResult> => {
    const [lo, hi] = ordered(customerA, customerB)
    await lockCrmIdentity(tx)
    await lockPair(tx, lo, hi)
    const inputs = await loadClusterInputs(tx, lo)
    const extra = await loadClusterInputs(tx, hi)
    const customers = new Map([...inputs.customers, ...extra.customers].map((c) => [c.id, c]))
    const a = customers.get(lo)
    const b = customers.get(hi)
    if (!a || !b) return { success: false, error: 'Customer not found' }
    if (a.anonymised || b.anonymised) return { success: false, error: 'An anonymised customer cannot be merged' }
    if (await erasureInFlight(tx, [lo, hi])) return { success: false, error: ERASURE_IN_PROGRESS_ERROR }
    const decisions = newestOperatorDecisions([...inputs.decisions, ...extra.decisions])
    if (effectiveLink(a, b, decisions.get(pairKey(lo, hi)))) return { success: false, error: 'These customers are already the same person' }
    await tx.customerMergeEvent.create({ data: { kind: 'MERGE', source: 'OPERATOR', customerId: lo, otherCustomerId: hi, decidedByUserId: userId } })
    await logActivityInTransaction(tx, { entityType: 'CUSTOMER', entityId: lo, tag: 'sales', action: CUSTOMER_MERGED_ACTION, description: MERGED_DESCRIPTION, metadata: { customerIds: [lo, hi] }, userId })
    return { success: true, clusterIds: (await clusterOf(tx, lo)).ids }
  }, { maxWait: 10_000, timeout: 30_000 })
}

/**
 * Operator UNMERGE: split `customerId` out of its cluster by blocking its link to EVERY other member (an UNMERGE row per pair). Members that are still
 * linked to each other stay together. Refuses a customer that is not merged with anyone.
 */
export async function unmergeCustomer(customerId: string, userId: string): Promise<MergeResult> {
  return db.$transaction(async (tx): Promise<MergeResult> => {
    await lockCrmIdentity(tx)
    const before = await clusterOf(tx, customerId)
    if (await erasureInFlight(tx, before.ids)) return { success: false, error: ERASURE_IN_PROGRESS_ERROR }
    if (before.ids.length < 2) return { success: false, error: 'This customer is not merged with anyone' }
    const others = before.ids.filter((id) => id !== customerId)
    for (const other of others) {
      const [lo, hi] = ordered(customerId, other)
      await lockPair(tx, lo, hi)
    }
    const inputs = await loadClusterInputs(tx, customerId)
    const byId = new Map(inputs.customers.map((c) => [c.id, c]))
    const decisions = newestOperatorDecisions(inputs.decisions)
    const self = byId.get(customerId)
    if (!self) return { success: false, error: 'Customer not found' }
    let written = 0
    for (const other of others) {
      const o = byId.get(other)
      const [lo, hi] = ordered(customerId, other)
      // Only a pair that is linked NOW needs a blocking row; a pair that is not linked already stays apart.
      if (!o || !effectiveLink(self, o, decisions.get(pairKey(lo, hi)))) continue
      await tx.customerMergeEvent.create({ data: { kind: 'UNMERGE', source: 'OPERATOR', customerId: lo, otherCustomerId: hi, decidedByUserId: userId } })
      written += 1
    }
    if (written === 0) return { success: false, error: 'This customer is not merged with anyone' }
    await logActivityInTransaction(tx, { entityType: 'CUSTOMER', entityId: customerId, tag: 'sales', action: CUSTOMER_UNMERGED_ACTION, description: UNMERGED_DESCRIPTION, metadata: { customerId, separatedFrom: others }, userId })
    return { success: true, clusterIds: (await clusterOf(tx, customerId)).ids }
  }, { maxWait: 10_000, timeout: 30_000 })
}

/**
 * AUTO-MERGE AUDIT. For each pair of the customer's cluster that the DERIVED rule joins and that has NO row at all yet, write one AUTO_EMAIL MERGE row.
 * Idempotent (a second call writes nothing) and race-safe (a transaction advisory lock per pair; the table has no unique key to say so) and BOUNDED (at most AUTO_MERGE_AUDIT_MAX_PAIRS pairs per call). Runs inside the
 * caller's transaction, so an order import that creates a duplicate-by-email customer records the link atomically with it. Returns how many rows it wrote.
 *
 * It does NOT decide anything: the resolver joins these customers with or without the row.
 */
/** At most this many pair rows (and so pair locks) per call: the audit decides nothing, and a customer joining a large cluster must not hold the importer's transaction open over every member. */
export const AUTO_MERGE_AUDIT_MAX_PAIRS = 5

export async function recordAutoMergeAudit(tx: Prisma.TransactionClient, customerId: string): Promise<number> {
  const inputs = await loadClusterInputs(tx, customerId)
  const byId = new Map(inputs.customers.map((c) => [c.id, c]))
  const self = byId.get(customerId)
  if (!self || self.anonymised) return 0
  let written = 0
  // Oldest members first (cuid ids sort by creation), so the new customer is recorded against the same few members however large the cluster is.
  const peers = inputs.customers.filter((other) => other.id !== customerId && derivedLink(self, other)).sort((x, y) => (x.id < y.id ? -1 : 1))
  for (const other of peers.slice(0, AUTO_MERGE_AUDIT_MAX_PAIRS)) {
    const [lo, hi] = ordered(customerId, other.id)
    await lockPair(tx, lo, hi)
    const existing = await tx.customerMergeEvent.findFirst({ where: { customerId: lo, otherCustomerId: hi }, select: { id: true } })
    if (existing) continue
    await tx.customerMergeEvent.create({ data: { kind: 'MERGE', source: 'AUTO_EMAIL', customerId: lo, otherCustomerId: hi, decidedByUserId: null } })
    written += 1
  }
  return written
}
