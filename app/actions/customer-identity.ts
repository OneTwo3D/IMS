'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireFreshRole, requirePermission, requireRole } from '@/lib/auth/server'
import { clusterOf } from '@/lib/domain/crm/cluster-resolver'
import { loadCompanyGroup, type CompanyGroup } from '@/lib/domain/crm/company-group'
import { mergeCustomers, unmergeCustomer } from '@/lib/domain/crm/merge-service'
import { cancelClusterErasure, excludeClusterErasureMember } from '@/lib/domain/erasure/cluster-erasure-control'
import { loadTimeline, type TimelinePage } from '@/lib/domain/crm/timeline'

/**
 * CRM server actions. Reads need the `sales` permission (every sales user, owner decision Q6); merge and unmerge need the MANAGER or ADMIN role (Q7).
 * Merge and unmerge also need a FRESH sign-in (requireFreshRole) and an explicit confirmation after the operator has seen both customers' names and emails. None of them writes to a Customer row, an order, or any external system.
 */

export type CustomerClusterMember = {
  id: string
  fullName: string
  email: string | null
  company: string | null
  orderCount: number
  anonymised: boolean
}

export type CustomerIdentityView = {
  customerId: string
  /** The cluster, the customer asked about first. One entry when the customer is not merged with anyone. */
  members: CustomerClusterMember[]
  /** True when the cluster is larger than the walk limit and only a part is shown. */
  truncated: boolean
  company: CompanyGroup
  canMerge: boolean
  /** A PENDING whole-person erasure that covers this customer's cluster, or null. Shown with cancel / exclude controls to MANAGER and ADMIN. */
  pendingErasure: PendingErasureView | null
}

export type PendingErasureView = {
  requestId: string
  requestedCustomerId: string
  /** The saved list: erased members have no name or email left. */
  members: Array<{ id: string; label: string; erased: boolean }>
}

const MERGE_ROLES = ['MANAGER', 'ADMIN'] as const

export async function getCustomerIdentity(customerId: string): Promise<CustomerIdentityView | null> {
  const session = await requirePermission('sales')
  const exists = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } })
  if (!exists) return null
  const cluster = await clusterOf(db, customerId)
  const rows = await db.customer.findMany({
    where: { id: { in: cluster.ids } },
    select: { id: true, firstName: true, lastName: true, email: true, company: true, gdprAnonymisedAt: true, _count: { select: { salesOrders: true } } },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const members = [customerId, ...cluster.ids.filter((id) => id !== customerId)].flatMap((id) => {
    const r = byId.get(id)
    return r ? [{ id: r.id, fullName: `${r.firstName} ${r.lastName}`.trim(), email: r.email, company: r.company, orderCount: r._count.salesOrders, anonymised: r.gdprAnonymisedAt !== null }] : []
  })
  const company = await loadCompanyGroup(db, customerId, cluster.ids)
  const pending = await db.customerClusterErasure.findFirst({ where: { status: 'PENDING', memberIds: { hasSome: cluster.ids } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  let pendingErasure: PendingErasureView | null = null
  if (pending) {
    const saved = await db.customer.findMany({ where: { id: { in: pending.memberIds } }, select: { id: true, firstName: true, lastName: true, email: true, gdprAnonymisedAt: true } })
    const savedById = new Map(saved.map((r) => [r.id, r]))
    pendingErasure = {
      requestId: pending.id,
      requestedCustomerId: pending.requestedCustomerId,
      members: pending.memberIds.map((id) => {
        const r = savedById.get(id)
        if (!r || r.gdprAnonymisedAt) return { id, label: 'Erased record', erased: true }
        return { id, label: [`${r.firstName} ${r.lastName}`.trim(), r.email].filter(Boolean).join(' - ') || id, erased: false }
      }),
    }
  }
  return { customerId, members, truncated: cluster.truncated, company, canMerge: (MERGE_ROLES as readonly string[]).includes(session.user.role), pendingErasure }
}

/** The timeline of one customer, or of its whole cluster (`scope: 'person'`, the default). Keyset pagination: pass the previous page's `nextCursor`. */
export async function getCustomerTimeline(
  customerId: string,
  options: { scope?: 'person' | 'customer'; cursor?: string | null } = {},
): Promise<TimelinePage | null> {
  await requirePermission('sales')
  const exists = await db.customer.findUnique({ where: { id: customerId }, select: { id: true } })
  if (!exists) return null
  const ids = options.scope === 'customer' ? [customerId] : (await clusterOf(db, customerId)).ids
  return loadTimeline(db, ids, { cursor: options.cursor })
}

export type MergeActionResult = { success: true } | { success: false; error: string; code?: string; reason?: string }

export type MergePreviewCustomer = { id: string; fullName: string; email: string | null; company: string | null; orderCount: number }
export type MergePreview = { success: true; a: MergePreviewCustomer; b: MergePreviewCustomer } | { success: false; error: string }

const CONFIRM_REQUIRED = 'Confirm the merge after checking both customers. Nothing was changed.'

/**
 * What a merge would join: both customers' names and emails, for the confirmation step. A merge decides which strangers a later whole-person erasure
 * anonymises irreversibly, so the operator must see WHO before it is made. MANAGER or ADMIN only; reads only.
 */
export async function previewMergeAction(customerA: string, customerB: string): Promise<MergePreview> {
  await requireRole(...MERGE_ROLES)
  if (customerA === customerB) return { success: false, error: 'Choose two different customers' }
  const rows = await db.customer.findMany({
    where: { id: { in: [customerA, customerB] } },
    select: { id: true, firstName: true, lastName: true, email: true, company: true, gdprAnonymisedAt: true, _count: { select: { salesOrders: true } } },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const a = byId.get(customerA)
  const b = byId.get(customerB)
  if (!a || !b) return { success: false, error: 'Customer not found' }
  if (a.gdprAnonymisedAt || b.gdprAnonymisedAt) return { success: false, error: 'An anonymised customer cannot be merged' }
  const view = (r: typeof a): MergePreviewCustomer => ({ id: r.id, fullName: `${r.firstName} ${r.lastName}`.trim(), email: r.email, company: r.company, orderCount: r._count.salesOrders })
  return { success: true, a: view(a), b: view(b) }
}

/** Merge needs a FRESH sign-in (MANAGER or ADMIN) and an explicit `confirmed: true` given after the preview. */
export async function mergeCustomersAction(customerA: string, customerB: string, confirmed: boolean): Promise<MergeActionResult> {
  try {
    const session = await requireFreshRole(...MERGE_ROLES)
    if (confirmed !== true) return { success: false, error: CONFIRM_REQUIRED }
    const result = await mergeCustomers(customerA, customerB, session.user.id!)
    if (!result.success) return result
    revalidatePath(`/sales/contacts/${customerA}`)
    revalidatePath(`/sales/contacts/${customerB}`)
    return { success: true }
  } catch (error) {
    const fresh = freshAuthFailureResult(error)
    if (fresh) return fresh
    throw error
  }
}

/** Unmerge needs a FRESH sign-in (MANAGER or ADMIN) and an explicit `confirmed: true`. */
export async function unmergeCustomerAction(customerId: string, confirmed: boolean): Promise<MergeActionResult> {
  try {
    const session = await requireFreshRole(...MERGE_ROLES)
    if (confirmed !== true) return { success: false, error: CONFIRM_REQUIRED }
    const result = await unmergeCustomer(customerId, session.user.id!)
    if (!result.success) return result
    revalidatePath(`/sales/contacts/${customerId}`)
    for (const id of result.clusterIds) revalidatePath(`/sales/contacts/${id}`)
    return { success: true }
  } catch (error) {
    const fresh = freshAuthFailureResult(error)
    if (fresh) return fresh
    throw error
  }
}

/** Cancel a PENDING person erasure: MANAGER or ADMIN, FRESH sign-in, a reason, audited. Records already erased stay erased; the merge/unmerge block is released. */
export async function cancelClusterErasureAction(requestId: string, reason: string): Promise<MergeActionResult> {
  try {
    const session = await requireFreshRole(...MERGE_ROLES)
    const result = await cancelClusterErasure(requestId, reason, session.user.id!)
    if (!result.success) return result
    revalidatePath('/sales/contacts')
    return { success: true }
  } catch (error) {
    const fresh = freshAuthFailureResult(error)
    if (fresh) return fresh
    throw error
  }
}

/** Exclude one wrongly included member from a PENDING person erasure before it is resumed: MANAGER or ADMIN, FRESH sign-in, a reason, audited. */
export async function excludeClusterErasureMemberAction(requestId: string, customerId: string, reason: string): Promise<MergeActionResult> {
  try {
    const session = await requireFreshRole(...MERGE_ROLES)
    const result = await excludeClusterErasureMember(requestId, customerId, reason, session.user.id!)
    if (!result.success) return result
    revalidatePath(`/sales/contacts/${customerId}`)
    return { success: true }
  } catch (error) {
    const fresh = freshAuthFailureResult(error)
    if (fresh) return fresh
    throw error
  }
}
