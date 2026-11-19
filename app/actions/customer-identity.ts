'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission, requireRole } from '@/lib/auth/server'
import { clusterOf } from '@/lib/domain/crm/cluster-resolver'
import { loadCompanyGroup, type CompanyGroup } from '@/lib/domain/crm/company-group'
import { mergeCustomers, unmergeCustomer } from '@/lib/domain/crm/merge-service'
import { loadTimeline, type TimelinePage } from '@/lib/domain/crm/timeline'

/**
 * CRM server actions. Reads need the `sales` permission (every sales user, owner decision Q6); merge and unmerge need the MANAGER or ADMIN role (Q7).
 * None of them writes to a Customer row, an order, or any external system.
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
  return { customerId, members, truncated: cluster.truncated, company, canMerge: (MERGE_ROLES as readonly string[]).includes(session.user.role) }
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

export type MergeActionResult = { success: true } | { success: false; error: string }

export async function mergeCustomersAction(customerA: string, customerB: string): Promise<MergeActionResult> {
  const session = await requireRole(...MERGE_ROLES)
  const result = await mergeCustomers(customerA, customerB, session.user.id!)
  if (!result.success) return result
  revalidatePath(`/sales/contacts/${customerA}`)
  revalidatePath(`/sales/contacts/${customerB}`)
  return { success: true }
}

export async function unmergeCustomerAction(customerId: string): Promise<MergeActionResult> {
  const session = await requireRole(...MERGE_ROLES)
  const result = await unmergeCustomer(customerId, session.user.id!)
  if (!result.success) return result
  revalidatePath(`/sales/contacts/${customerId}`)
  for (const id of result.clusterIds) revalidatePath(`/sales/contacts/${id}`)
  return { success: true }
}
