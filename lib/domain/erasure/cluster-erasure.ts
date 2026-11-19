/**
 * ERASING A MERGED PERSON (CRM foundation, owner decision 2026-11-18): an erasure of one customer erases EVERY live record in its cluster
 * (lib/domain/crm/cluster-resolver.ts), because the records are one person and leaving a duplicate behind would leave that person's data in place.
 *
 * It is a loop over the existing per-customer erasure (eraseCustomerPersonalData), not a second implementation: each member is erased by the same core, under
 * the same locks, with its own name-free erasure record, so every census and test of that core applies to every member.
 *
 * THE SNAPSHOT. The cluster is resolved ONCE, inside a transaction that holds the CRM identity lock (lib/db/advisory-locks.ts), the lock every merge and unmerge
 * takes, so the member list is read against a state no merge or unmerge is changing. It is then SAVED on a customer_cluster_erasures row (ids only) before the
 * first member is touched. While that request is PENDING, merge and unmerge refuse its members (merge-service.ts), so the saved list can not go stale in a way
 * that erases someone an operator has since separated.
 *
 * NOT ONE TRANSACTION, BUT RESUMABLE. The members are erased one after another, each atomically. If one fails the others stay erased and the result says so.
 * Running the erasure again, from ANY member of the saved list (erased or not), RESUMES FROM THE SAVED LIST: it does not re-resolve (erasing a member blanks the
 * email the resolver joins on and an anonymised customer leaves every cluster, so a member reachable only through an erased one would be lost). Members already
 * erased are skipped; the request is marked COMPLETE when every member is. The order is: members that hold the cluster together LAST (erasureOrder), the
 * customer the request was made for at the very end. A cluster too large to resolve completely (MAX_CLUSTER_MEMBERS) is REFUSED rather than partly erased.
 *
 * The merge audit rows (customer_merge_events) and the request rows hold ids only and are kept: they are not personal data and the audit trail must survive the
 * erasure. This makes NO external call.
 */
import { db } from '@/lib/db'
import { clusterForErasure, MAX_CLUSTER_MEMBERS } from '@/lib/domain/crm/cluster-resolver'
import { lockCrmIdentity } from '@/lib/domain/crm/identity-lock'
import { eraseCustomerPersonalData } from './erase-personal-data'
import { EMPTY_WAREHOUSE_SUMMARY, type ErasureTrigger, type ErasureWarehouseSummary } from './erasure-record'

export type EraseClusterResult =
  | { success: true; requestId: string; erasedCustomerIds: string[]; warehouse: ErasureWarehouseSummary }
  | { success: false; error: string; erasedCustomerIds: string[] }

export const CLUSTER_CHANGED_ERROR = 'The merged records of this person changed since this page was opened. Nothing was erased; reload the page and check the list again.'

export const CLUSTER_TOO_LARGE_ERROR = `This person is merged with more than ${MAX_CLUSTER_MEMBERS} customer records, which cannot be erased in one request. Nothing was erased; unmerge some records first.`

export type EraseCustomerFn = typeof eraseCustomerPersonalData

type Options = {
  trigger: ErasureTrigger
  userId: string | null
  /** The member ids the operator was shown when they confirmed. A NEW snapshot that differs is refused (the merged records changed since); a resumed request ignores it. */
  expectedMemberIds?: ReadonlyArray<string>
}

type Plan = { ok: true; requestId: string; members: string[] } | { ok: false; error: string }

async function planErasure(customerId: string, options: Options): Promise<Plan> {
  return db.$transaction(async (tx): Promise<Plan> => {
    await lockCrmIdentity(tx)
    const open = await tx.customerClusterErasure.findFirst({ where: { status: 'PENDING', memberIds: { has: customerId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    if (open) return { ok: true, requestId: open.id, members: open.memberIds }
    // The customer asked about is checked FIRST, so a refusal about it is reported before anything is touched.
    const self = await tx.customer.findUnique({ where: { id: customerId }, select: { gdprAnonymisedAt: true } })
    if (!self) return { ok: false, error: 'Customer not found' }
    if (self.gdprAnonymisedAt) return { ok: false, error: 'Customer already anonymised' }
    const cluster = await clusterForErasure(tx, customerId)
    if (cluster.truncated) return { ok: false, error: CLUSTER_TOO_LARGE_ERROR }
    if (options.expectedMemberIds && [...options.expectedMemberIds].sort().join('|') !== cluster.ids.join('|')) return { ok: false, error: CLUSTER_CHANGED_ERROR }
    const request = await tx.customerClusterErasure.create({ data: { requestedCustomerId: customerId, memberIds: cluster.order, requestedByUserId: options.userId }, select: { id: true } })
    return { ok: true, requestId: request.id, members: cluster.order }
  }, { maxWait: 10_000, timeout: 30_000 })
}

export async function eraseCustomerClusterPersonalData(
  customerId: string,
  options: Options,
  deps: { eraseCustomer: EraseCustomerFn } = { eraseCustomer: eraseCustomerPersonalData },
): Promise<EraseClusterResult> {
  const plan = await planErasure(customerId, options)
  if (!plan.ok) return { success: false, error: plan.error, erasedCustomerIds: [] }
  const result = await eraseMembers(plan.members, options, deps.eraseCustomer)
  if (result.success) {
    await db.customerClusterErasure.updateMany({ where: { id: plan.requestId, status: 'PENDING' }, data: { status: 'COMPLETE', completedAt: new Date() } })
    return { ...result, requestId: result.requestId || plan.requestId }
  }
  return result
}

async function eraseMembers(members: string[], options: { trigger: ErasureTrigger; userId: string | null }, eraseCustomer: EraseCustomerFn): Promise<EraseClusterResult> {
  const erased: string[] = []
  let requestId = ''
  const warehouse: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] }
  for (const memberId of members) {
    const result = await eraseCustomer(memberId, { trigger: options.trigger, userId: options.userId })
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
