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
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
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
  /**
   * The member ids the operator was shown when they confirmed. REQUIRED for a NEW request: the server computes the cluster itself and refuses unless this is
   * exactly that list (a merge, unmerge or imported alias since the page was opened is refused, not erased unseen). A missing list is the empty list and is
   * refused the same way. A resumed PENDING request ignores it (it runs from the saved list).
   */
  expectedMemberIds?: ReadonlyArray<string>
}

type Plan = { ok: true; requestId: string; members: string[] } | { ok: false; error: string }

/** Operator notice (activity log, WARNING) when the request cannot be completed because the cluster keeps growing or is too large to re-resolve. */
export const ERASURE_MEMBERS_GREW_ACTION = 'customer_erasure_members_grew'
export const ERASURE_RESYNC_INCOMPLETE_ACTION = 'customer_erasure_resync_incomplete'

type Tx = Prisma.TransactionClient

/**
 * Re-resolve the cluster of a PENDING request from every member of it that is still live, under the global CRM lock the caller already holds, and APPEND any live
 * record that has joined since (an alias imported after the snapshot: the importer takes the shared CRM lock when it creates a customer, so it serialises with this).
 * Members are only ever added here, never removed; an operator-excluded member is never added back. Returns the ids appended (in erasure order) and whether the
 * walk was cut short by MAX_CLUSTER_MEMBERS.
 */
async function appendNewMembers(tx: Tx, request: { id: string; memberIds: string[]; excludedMemberIds: string[] }): Promise<{ added: string[]; truncated: boolean }> {
  const known = new Set(request.memberIds)
  const excluded = new Set(request.excludedMemberIds)
  const live = await tx.customer.findMany({ where: { id: { in: request.memberIds }, gdprAnonymisedAt: null }, select: { id: true } })
  const found = new Set<string>()
  let truncated = false
  for (const { id } of live) {
    const cluster = await clusterForErasure(tx, id)
    truncated = truncated || cluster.truncated
    for (const m of cluster.order) if (!known.has(m) && !excluded.has(m)) found.add(m)
  }
  const added = [...found].sort()
  if (added.length > 0) {
    if (request.memberIds.length + added.length > MAX_CLUSTER_MEMBERS) return { added: [], truncated: true }
    await tx.customerClusterErasure.update({ where: { id: request.id }, data: { memberIds: [...added, ...request.memberIds] } })
  }
  return { added, truncated }
}

async function planErasure(customerId: string, options: Options): Promise<Plan> {
  return db.$transaction(async (tx): Promise<Plan> => {
    await lockCrmIdentity(tx)
    const open = await tx.customerClusterErasure.findFirst({ where: { status: 'PENDING', memberIds: { has: customerId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    if (open) {
      // A resume also picks up records that joined since the request was saved (they are erased first, before the saved list).
      const grown = await appendNewMembers(tx, open)
      return { ok: true, requestId: open.id, members: [...grown.added, ...open.memberIds] }
    }
    // The customer asked about is checked FIRST, so a refusal about it is reported before anything is touched.
    const self = await tx.customer.findUnique({ where: { id: customerId }, select: { gdprAnonymisedAt: true } })
    if (!self) return { ok: false, error: 'Customer not found' }
    if (self.gdprAnonymisedAt) return { ok: false, error: 'Customer already anonymised' }
    const cluster = await clusterForErasure(tx, customerId)
    if (cluster.truncated) return { ok: false, error: CLUSTER_TOO_LARGE_ERROR }
    if ([...(options.expectedMemberIds ?? [])].sort().join('|') !== cluster.ids.join('|')) return { ok: false, error: CLUSTER_CHANGED_ERROR }
    const request = await tx.customerClusterErasure.create({ data: { requestedCustomerId: customerId, memberIds: cluster.order, requestedByUserId: options.userId }, select: { id: true } })
    return { ok: true, requestId: request.id, members: cluster.order }
  }, { maxWait: 10_000, timeout: 30_000 })
}

/** The most rounds of "erase, then look for records that joined meanwhile" before the request is left PENDING with an operator notice. */
const MAX_RESYNC_ROUNDS = 5

type FinalPhase =
  | { kind: 'complete'; last: Awaited<ReturnType<EraseCustomerFn>> | null }
  | { kind: 'extra'; extra: string[] }
  | { kind: 'failed'; error: string }
  | { kind: 'stop'; reason: 'truncated' | 'not-pending' }

/**
 * THE LAST MEMBER, UNDER THE LOCK. Every member but the last has been erased. Under the global CRM lock, re-resolve the cluster from every member still live (the last
 * one included) and append any record that joined since the snapshot or the previous round (an alias imported after it): those are returned as `extra`, to be erased
 * first. Only when nothing new is found is the last member erased, STILL HOLDING the lock (the importer takes the shared mode of it when it creates a customer, so no
 * record can join this person between the check and the erasure), and the request stamped COMPLETE in the same transaction. The re-resolve has to happen while a member
 * is still live: an erased member has no email left to join anything on. The core takes no CRM lock, so holding it here cannot deadlock.
 */
async function finalPhase(requestId: string, finalId: string, options: Options, eraseCustomer: EraseCustomerFn): Promise<FinalPhase> {
  return db.$transaction(async (tx): Promise<FinalPhase> => {
    await lockCrmIdentity(tx)
    const request = await tx.customerClusterErasure.findUnique({ where: { id: requestId } })
    if (!request || request.status !== 'PENDING') return { kind: 'stop', reason: 'not-pending' }
    const grown = await appendNewMembers(tx, request)
    if (grown.truncated) return { kind: 'stop', reason: 'truncated' }
    if (grown.added.length > 0) return { kind: 'extra', extra: grown.added }
    let last: Awaited<ReturnType<EraseCustomerFn>> | null = null
    const row = await tx.customer.findUnique({ where: { id: finalId }, select: { gdprAnonymisedAt: true } })
    if (row && !row.gdprAnonymisedAt) {
      last = await eraseCustomer(finalId, { trigger: options.trigger, userId: options.userId })
      // already anonymised by someone else since: done; anything else leaves the request PENDING
      if (!last.success && last.error !== 'Customer already anonymised') return { kind: 'failed', error: last.error }
    }
    await tx.customerClusterErasure.update({ where: { id: requestId }, data: { status: 'COMPLETE', completedAt: new Date() } })
    return { kind: 'complete', last: last && last.success ? last : null }
  }, { maxWait: 10_000, timeout: 120_000 })
}

async function recordNotice(kind: 'grew' | 'incomplete', customerId: string, requestId: string, count: number, userId: string | null): Promise<void> {
  try {
    if (kind === 'grew') {
      await logActivity({ entityType: 'CUSTOMER', entityId: customerId, tag: 'sales', level: 'WARNING', action: ERASURE_MEMBERS_GREW_ACTION, description: 'Records of the person joined after the erasure was requested and were erased with it (counts only).', metadata: { requestId, count }, userId, resolveUser: false })
    } else {
      await logActivity({ entityType: 'CUSTOMER', entityId: customerId, tag: 'sales', level: 'WARNING', action: ERASURE_RESYNC_INCOMPLETE_ACTION, description: 'A person erasure could not be completed: records of the person kept appearing or the cluster is too large to re-check. The request stays open.', metadata: { requestId, count }, userId, resolveUser: false })
    }
  } catch (e) {
    console.error('cluster erasure notice: could not record', e instanceof Error ? e.constructor.name : typeof e)
  }
}

export const ERASURE_RESYNC_INCOMPLETE_ERROR = 'The erasure of the listed records is done, but more records of this person keep appearing (or the merged person is too large to re-check). The request stays open; run the erasure again, or cancel it.'

export async function eraseCustomerClusterPersonalData(
  customerId: string,
  options: Options,
  deps: { eraseCustomer: EraseCustomerFn } = { eraseCustomer: eraseCustomerPersonalData },
): Promise<EraseClusterResult> {
  const plan = await planErasure(customerId, options)
  if (!plan.ok) return { success: false, error: plan.error, erasedCustomerIds: [] }
  const finalId = plan.members[plan.members.length - 1]!
  const erased: string[] = []
  let requestId = ''
  let warehouse: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] }
  const absorb = (r: { erasedCustomerIds: string[]; requestId: string; warehouse: ErasureWarehouseSummary }) => {
    erased.push(...r.erasedCustomerIds)
    requestId = r.requestId || requestId
    warehouse = mergeWarehouse(warehouse, r.warehouse)
  }
  const head = await eraseMembers(plan.members.slice(0, -1), options, deps.eraseCustomer)
  if (!head.success) return head
  absorb(head)
  for (let round = 0; ; round += 1) {
    const phase = await finalPhase(plan.requestId, finalId, options, deps.eraseCustomer)
    if (phase.kind === 'failed') return { success: false, error: `${erased.length} of ${plan.members.length} customer records were erased before this one failed: ${phase.error}. Run the erasure again to finish.`, erasedCustomerIds: erased }
    if (phase.kind === 'complete') {
      if (phase.last?.success) {
        erased.push(finalId)
        requestId = phase.last.requestId || requestId
        warehouse = mergeWarehouse(warehouse, phase.last.warehouse)
      }
      return { success: true, requestId: requestId || plan.requestId, erasedCustomerIds: erased, warehouse }
    }
    if (phase.kind === 'stop' && phase.reason === 'not-pending') return { success: true, requestId: requestId || plan.requestId, erasedCustomerIds: erased, warehouse }
    if (phase.kind === 'stop' || round >= MAX_RESYNC_ROUNDS) {
      await recordNotice('incomplete', customerId, plan.requestId, erased.length, options.userId)
      return { success: false, error: ERASURE_RESYNC_INCOMPLETE_ERROR, erasedCustomerIds: erased }
    }
    await recordNotice('grew', customerId, plan.requestId, phase.extra.length, options.userId)
    const next = await eraseMembers(phase.extra, options, deps.eraseCustomer)
    if (!next.success) return { ...next, erasedCustomerIds: [...erased, ...next.erasedCustomerIds] }
    absorb(next)
  }
}

function mergeWarehouse(a: ErasureWarehouseSummary, b: ErasureWarehouseSummary): ErasureWarehouseSummary {
  const out: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [...a.openOrders, ...b.openOrders], ambiguousOrders: [...a.ambiguousOrders, ...b.ambiguousOrders] }
  for (const key of ['linkedOrders', 'despatched', 'open', 'cancelled', 'notPushed', 'ambiguous', 'merged'] as const) out[key] = a[key] + b[key]
  return out
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
