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
 * CANCEL AND EXCLUDE DURING A RUN. Before EACH member the request is re-read under the exclusive CRM lock (the lock cancel and exclude take), in the SAME transaction as that
 * member's erasure (the core runs on it): a request no longer PENDING stops the run with a "cancelled" result, and a member that was excluded or removed is skipped. An
 * exclude or cancel therefore either commits before the check or waits for the member in flight, so an operator who is told a member was spared never has it erased.
 *
 * The merge audit rows (customer_merge_events) and the request rows hold ids only and are kept: they are not personal data and the audit trail must survive the
 * erasure. This makes NO external call.
 */
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { clusterForErasure, MAX_CLUSTER_MEMBERS, liveCustomersByIdentityDigest } from '@/lib/domain/crm/cluster-resolver'
import { looseIdentityEmail } from '@/lib/domain/crm/identity-key'
import { lockCrmIdentity } from '@/lib/domain/crm/identity-lock'
import { eraseCustomerPersonalData } from './erase-personal-data'
import { CustomerKeysChanged, lockStorefrontCustomerKeys, readStorefrontCustomerIds } from './customer-key-lock'
import { EMPTY_WAREHOUSE_SUMMARY, ERASURE_FAILURE_ACTION, ERASURE_FAILURE_DESCRIPTION, type ErasureTrigger, type ErasureWarehouseSummary } from './erasure-record'

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

const keyDigest = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

/** member id -> SHA-256 of the loose identity key of its CURRENT email (live members with a usable email only). Read while the members are still live. */
async function identityDigests(tx: Tx, ids: string[]): Promise<Record<string, string>> {
  const rows = await tx.customer.findMany({ where: { id: { in: ids }, gdprAnonymisedAt: null }, select: { id: true, email: true } })
  const out: Record<string, string> = {}
  for (const r of rows) {
    const key = looseIdentityEmail(r.email)
    if (key) out[r.id] = keyDigest(key)
  }
  return out
}

const savedDigests = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v
  return out
}

/**
 * Re-resolve the cluster of a PENDING request, under the global CRM lock the caller already holds, and APPEND any live record that has joined since (an alias imported
 * after the snapshot: the importer takes the shared CRM lock when it creates a customer, so it serialises with this). It resolves from EVERY plan member:
 *  - each member still live, through the normal resolver; and
 *  - each member ALREADY ERASED, through the digest of the identity key its email had before it was erased (saved on the request): an erased member's email is blank, so
 *    a record that joins the person only through it (a cluster joined by a merge, whose alias arrives mid-run) is found by that key.
 * Members are only ever added here, never removed; an operator-excluded member is never added back. Returns the ids appended (in erasure order) and whether the walk was
 * cut short by MAX_CLUSTER_MEMBERS.
 */
async function appendNewMembers(tx: Tx, request: { id: string; memberIds: string[]; excludedMemberIds: string[]; memberIdentityKeys: unknown }): Promise<{ added: string[]; truncated: boolean }> {
  const known = new Set(request.memberIds)
  const excluded = new Set(request.excludedMemberIds)
  const saved = savedDigests(request.memberIdentityKeys)
  const live = await tx.customer.findMany({ where: { id: { in: request.memberIds }, gdprAnonymisedAt: null }, select: { id: true } })
  const seeds = new Set(live.map((r) => r.id))
  const digests = [...new Set(request.memberIds.map((id) => saved[id]).filter((d): d is string => typeof d === 'string'))]
  if (digests.length > 0) {
    const peers = await liveCustomersByIdentityDigest(tx, digests)
    for (const p of peers) if (!known.has(p.id) && !excluded.has(p.id)) seeds.add(p.id)
  }
  const found = new Set<string>()
  let truncated = false
  for (const id of seeds) {
    const cluster = await clusterForErasure(tx, id)
    truncated = truncated || cluster.truncated
    for (const m of cluster.order) if (!known.has(m) && !excluded.has(m)) found.add(m)
  }
  const added = [...found].sort()
  if (added.length > 0) {
    if (request.memberIds.length + added.length > MAX_CLUSTER_MEMBERS) return { added: [], truncated: true }
    // the new members are live now: save their keys too, so an alias of THEM that arrives after they are erased is found as well
    await tx.customerClusterErasure.update({ where: { id: request.id }, data: { memberIds: [...added, ...request.memberIds], memberIdentityKeys: { ...saved, ...(await identityDigests(tx, added)) } } })
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
    const request = await tx.customerClusterErasure.create({ data: { requestedCustomerId: customerId, memberIds: cluster.order, requestedByUserId: options.userId, memberIdentityKeys: await identityDigests(tx, cluster.order) }, select: { id: true } })
    return { ok: true, requestId: request.id, members: cluster.order }
  }, { maxWait: 10_000, timeout: 30_000 })
}

/** The most rounds of "erase, then look for records that joined meanwhile" before the request is left PENDING with an operator notice. */
const MAX_RESYNC_ROUNDS = 5

type FinalPhase =
  | { kind: 'complete'; last: Awaited<ReturnType<EraseCustomerFn>> | null }
  | { kind: 'extra'; extra: string[] }
  | { kind: 'failed'; error: string }
  | { kind: 'stop'; reason: 'truncated' | 'cancelled' | 'complete' }

export const ERASURE_CANCELLED_DURING_RUN_ERROR = 'This erasure request was cancelled while it was running. The records erased before that stay erased; nothing more was erased.'

const KEY_RETRIES = 3

/** A failure of a member's erasure transaction: logged by class name only (the exception text can echo the values being written) and reported as a failed result. */
async function recordFailure(customerId: string, options: Options, e: unknown): Promise<string> {
  try {
    await logActivity({ entityType: 'CUSTOMER', entityId: customerId, tag: 'sales', action: ERASURE_FAILURE_ACTION, level: 'ERROR', description: ERASURE_FAILURE_DESCRIPTION, metadata: { trigger: options.trigger, errorClass: e instanceof Error ? e.constructor.name : typeof e }, userId: options.userId })
  } catch (err) {
    console.error('cluster erasure failure notice: could not record', err instanceof Error ? err.constructor.name : typeof err)
  }
  return ERASURE_FAILURE_DESCRIPTION
}

/**
 * Take the locks of one member's erasure transaction in the GLOBAL order: the member's storefront key locks FIRST (the importer takes a key lock and then the shared CRM
 * lock, so taking the exclusive CRM lock before the key locks would invert that order and can stall behind an importer), then the exclusive CRM lock. The core re-takes
 * the key locks (a no-op on the same session) and throws CustomerKeysChanged when the member gained a storefront id meanwhile; the caller retries.
 */
async function lockForMember(tx: Tx, memberId: string): Promise<void> {
  await lockStorefrontCustomerKeys(tx, await readStorefrontCustomerIds(tx, memberId))
  await lockCrmIdentity(tx)
}

type MemberOutcome =
  | { kind: 'erased'; result: Extract<Awaited<ReturnType<EraseCustomerFn>>, { success: true }>; finish: () => Promise<void> }
  | { kind: 'skipped' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string }

/**
 * ONE MEMBER, CHECKED AND ERASED IN ONE TRANSACTION under the exclusive CRM lock, the lock cancel and exclude take. The request is re-read first: if it is no longer PENDING
 * the member is NOT erased (cancelled); if the member was excluded or removed from the list it is skipped. Because the check and the erasure share the transaction (and
 * the lock), an exclude or cancel either commits before the check (and is seen by it) or waits until this member is erased and then applies to the rest. The erasure core
 * runs on this transaction (options.tx), so there is no second connection and no wait cycle with the importer.
 */
async function eraseMemberGuarded(requestId: string, memberId: string, options: Options, eraseCustomer: EraseCustomerFn): Promise<MemberOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx): Promise<MemberOutcome> => {
        await lockForMember(tx, memberId)
        const request = await tx.customerClusterErasure.findUnique({ where: { id: requestId }, select: { status: true, memberIds: true, excludedMemberIds: true } })
        if (!request || request.status !== 'PENDING') return { kind: 'cancelled' }
        if (!request.memberIds.includes(memberId) || request.excludedMemberIds.includes(memberId)) return { kind: 'skipped' }
        const result = await eraseCustomer(memberId, { trigger: options.trigger, userId: options.userId, tx })
        if (!result.success) return result.error === 'Customer already anonymised' ? { kind: 'skipped' } : { kind: 'failed', error: result.error }
        return { kind: 'erased', result, finish: result.afterCommit ?? (async () => {}) }
      }, { maxWait: 10_000, timeout: 120_000 })
    } catch (e) {
      if (e instanceof CustomerKeysChanged && attempt < KEY_RETRIES) continue
      return { kind: 'failed', error: await recordFailure(memberId, options, e) }
    }
  }
}

/**
 * THE LAST MEMBER, UNDER THE LOCK. Every member but the last has been erased. Under the global CRM lock, re-resolve the cluster from EVERY plan member (live ones through the
 * resolver, erased ones through their saved identity digests: see appendNewMembers) and append any record that joined since the snapshot or the previous round: those are
 * returned as `extra`, to be erased first. Only when nothing new is found is the last member erased, on THIS transaction and so on the connection that holds the lock (the
 * importer takes the shared mode of the lock when it creates a customer, so no record can join this person between the check and the erasure), and the request stamped
 * COMPLETE in the same transaction: the erasure of the last member and the COMPLETE stamp commit together or not at all. The re-resolve has to happen while a member is
 * still live. A cancelled request is reported as cancelled, not as success.
 */
async function finalPhase(requestId: string, finalId: string, options: Options, eraseCustomer: EraseCustomerFn): Promise<FinalPhase> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      let finish: () => Promise<void> = async () => {}
      const phase = await db.$transaction(async (tx): Promise<FinalPhase> => {
        await lockForMember(tx, finalId)
        const request = await tx.customerClusterErasure.findUnique({ where: { id: requestId } })
        if (!request) return { kind: 'stop', reason: 'cancelled' }
        if (request.status === 'COMPLETE') return { kind: 'stop', reason: 'complete' }
        if (request.status !== 'PENDING') return { kind: 'stop', reason: 'cancelled' }
        const grown = await appendNewMembers(tx, request)
        if (grown.truncated) return { kind: 'stop', reason: 'truncated' }
        if (grown.added.length > 0) return { kind: 'extra', extra: grown.added }
        if (!request.memberIds.includes(finalId) || request.excludedMemberIds.includes(finalId)) return { kind: 'failed', error: 'The request changed while it was running' }
        let last: Awaited<ReturnType<EraseCustomerFn>> | null = null
        const row = await tx.customer.findUnique({ where: { id: finalId }, select: { gdprAnonymisedAt: true } })
        if (row && !row.gdprAnonymisedAt) {
          last = await eraseCustomer(finalId, { trigger: options.trigger, userId: options.userId, tx })
          // already anonymised by someone else since: done; anything else leaves the request PENDING
          if (!last.success && last.error !== 'Customer already anonymised') return { kind: 'failed', error: last.error }
          if (last.success && last.afterCommit) finish = last.afterCommit
        }
        await tx.customerClusterErasure.update({ where: { id: requestId }, data: { status: 'COMPLETE', completedAt: new Date(), memberIdentityKeys: {} } })
        return { kind: 'complete', last: last && last.success ? last : null }
      }, { maxWait: 10_000, timeout: 120_000 })
      if (phase.kind === 'complete') await finish()
      return phase
    } catch (e) {
      if (e instanceof CustomerKeysChanged && attempt < KEY_RETRIES) continue
      return { kind: 'failed', error: await recordFailure(finalId, options, e) }
    }
  }
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

export type ClusterErasureDeps = {
  eraseCustomer: EraseCustomerFn
  /** Test seam: awaited OUTSIDE any transaction, just before each member's guarded erasure, so a test can exclude or cancel between two members. */
  beforeMember?: (memberId: string) => Promise<void>
}

export async function eraseCustomerClusterPersonalData(
  customerId: string,
  options: Options,
  deps: ClusterErasureDeps = { eraseCustomer: eraseCustomerPersonalData },
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
  const head = await eraseMembers(plan.requestId, plan.members.slice(0, -1), options, deps)
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
    if (phase.kind === 'stop' && phase.reason === 'complete') return { success: true, requestId: requestId || plan.requestId, erasedCustomerIds: erased, warehouse }
    if (phase.kind === 'stop' && phase.reason === 'cancelled') return { success: false, error: ERASURE_CANCELLED_DURING_RUN_ERROR, erasedCustomerIds: erased }
    if (phase.kind === 'stop' || round >= MAX_RESYNC_ROUNDS) {
      await recordNotice('incomplete', customerId, plan.requestId, erased.length, options.userId)
      return { success: false, error: ERASURE_RESYNC_INCOMPLETE_ERROR, erasedCustomerIds: erased }
    }
    await recordNotice('grew', customerId, plan.requestId, phase.extra.length, options.userId)
    const next = await eraseMembers(plan.requestId, phase.extra, options, deps)
    if (!next.success) return { ...next, erasedCustomerIds: [...erased, ...next.erasedCustomerIds] }
    absorb(next)
  }
}

function mergeWarehouse(a: ErasureWarehouseSummary, b: ErasureWarehouseSummary): ErasureWarehouseSummary {
  const out: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [...a.openOrders, ...b.openOrders], ambiguousOrders: [...a.ambiguousOrders, ...b.ambiguousOrders] }
  for (const key of ['linkedOrders', 'despatched', 'open', 'cancelled', 'notPushed', 'ambiguous', 'merged'] as const) out[key] = a[key] + b[key]
  return out
}

async function eraseMembers(requestId: string, members: string[], options: Options, deps: ClusterErasureDeps): Promise<EraseClusterResult> {
  const erased: string[] = []
  let lastRequestId = ''
  const warehouse: ErasureWarehouseSummary = { ...EMPTY_WAREHOUSE_SUMMARY, openOrders: [], ambiguousOrders: [] }
  for (const memberId of members) {
    if (deps.beforeMember) await deps.beforeMember(memberId)
    const outcome = await eraseMemberGuarded(requestId, memberId, options, deps.eraseCustomer)
    // A cancel stops the run: no further member is erased, and the result says so (it is NOT a success).
    if (outcome.kind === 'cancelled') return { success: false, error: ERASURE_CANCELLED_DURING_RUN_ERROR, erasedCustomerIds: erased }
    // Excluded or removed from the list, or erased by someone else since the cluster was read: nothing to do.
    if (outcome.kind === 'skipped') continue
    // anything else stops the loop and is reported
    if (outcome.kind === 'failed') return { success: false, error: `${erased.length} of ${members.length} customer records were erased before this one failed: ${outcome.error}. Run the erasure again to finish.`, erasedCustomerIds: erased }
    await outcome.finish()
    const result = outcome.result
    erased.push(memberId)
    lastRequestId = result.requestId
    for (const key of ['linkedOrders', 'despatched', 'open', 'cancelled', 'notPushed', 'ambiguous', 'merged'] as const) warehouse[key] += result.warehouse[key]
    warehouse.openOrders.push(...result.warehouse.openOrders)
    warehouse.ambiguousOrders.push(...result.warehouse.ambiguousOrders)
  }
  return { success: true, requestId: lastRequestId, erasedCustomerIds: erased, warehouse }
}
