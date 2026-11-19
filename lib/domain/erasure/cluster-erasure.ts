/**
 * ERASING A MERGED PERSON (CRM foundation, owner decision 2026-11-18): an erasure of one customer erases EVERY live record in its cluster
 * (lib/domain/crm/cluster-resolver.ts), because the records are one person and leaving a duplicate behind would leave that person's data in place.
 *
 * It is a loop over the existing per-customer erasure (eraseCustomerPersonalData), not a second implementation: each member is erased by the same core, under
 * the same locks, with its own name-free erasure record, so every census and test of that core applies to every member. The cluster is resolved ONCE, before
 * anything is erased (erasing a member blanks the email the resolver joins on).
 *
 * NOT ONE TRANSACTION. The members are erased one after another, each atomically. If one fails the others stay erased and the result says so; the failed member
 * is still live, so running the erasure again (from any member that remains) finishes the job: the erased members have left the cluster (an anonymised
 * customer is never in a live cluster). The customer the request was made for is erased LAST, so it is still there to repeat the request from. A cluster too large to resolve completely
 * (MAX_CLUSTER_MEMBERS) is REFUSED rather than partly erased.
 *
 * The merge audit rows (customer_merge_events) hold ids only and are kept: they are not personal data and the audit trail must survive the erasure.
 * This makes NO external call.
 */
import { db } from '@/lib/db'
import { clusterOf, MAX_CLUSTER_MEMBERS } from '@/lib/domain/crm/cluster-resolver'
import { eraseCustomerPersonalData } from './erase-personal-data'
import { EMPTY_WAREHOUSE_SUMMARY, type ErasureTrigger, type ErasureWarehouseSummary } from './erasure-record'

export type EraseClusterResult =
  | { success: true; requestId: string; erasedCustomerIds: string[]; warehouse: ErasureWarehouseSummary }
  | { success: false; error: string; erasedCustomerIds: string[] }

export const CLUSTER_TOO_LARGE_ERROR = `This person is merged with more than ${MAX_CLUSTER_MEMBERS} customer records, which cannot be erased in one request. Nothing was erased; unmerge some records first.`

export async function eraseCustomerClusterPersonalData(
  customerId: string,
  options: { trigger: ErasureTrigger; userId: string | null },
): Promise<EraseClusterResult> {
  const cluster = await clusterOf(db, customerId)
  if (cluster.truncated) return { success: false, error: CLUSTER_TOO_LARGE_ERROR, erasedCustomerIds: [] }
  // The customer asked about is checked FIRST, so a refusal about it is reported before anything is touched.
  const self = await db.customer.findUnique({ where: { id: customerId }, select: { gdprAnonymisedAt: true } })
  if (!self) return { success: false, error: 'Customer not found', erasedCustomerIds: [] }
  if (self.gdprAnonymisedAt) return { success: false, error: 'Customer already anonymised', erasedCustomerIds: [] }
  // The customer asked about is erased LAST. It is the member the other records are joined to by a live email, so while it stands, a run that failed halfway
  // can be repeated from it (or from any other live member) and finds the same cluster minus the members already erased.
  return eraseMembers([...cluster.ids.filter((id) => id !== customerId), customerId], options)
}

async function eraseMembers(members: string[], options: { trigger: ErasureTrigger; userId: string | null }): Promise<EraseClusterResult> {
  const erased: string[] = []
  let requestId = ''
  const warehouse: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] }
  for (const memberId of members) {
    const result = await eraseCustomerPersonalData(memberId, options)
    if (!result.success) {
      // A member erased by someone else since the cluster was read is already done; anything else stops the loop and is reported.
      if (result.error === 'Customer already anonymised') continue
      return { success: false, error: `${erased.length} of ${members.length} customer records were erased before this one failed: ${result.error}. Run the erasure again to finish.`, erasedCustomerIds: erased }
    }
    erased.push(memberId)
    requestId = result.requestId
    for (const key of ['linkedOrders', 'despatched', 'open', 'cancelled', 'notPushed', 'ambiguous', 'merged'] as const) warehouse[key] += result.warehouse[key]
    warehouse.openOrders.push(...result.warehouse.openOrders)
    warehouse.ambiguousOrders.push(...result.warehouse.ambiguousOrders)
  }
  return { success: true, requestId, erasedCustomerIds: erased, warehouse }
}
