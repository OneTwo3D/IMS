/**
 * OPERATOR CONTROL OF A PENDING CLUSTER ERASURE (CRM foundation): CANCEL the request, or EXCLUDE one wrongly included member from it.
 *
 * A PENDING request (customer_cluster_erasures) blocks merge and unmerge of its members and is finished by running the erasure again, which erases the whole saved
 * list. Without these two actions a member that turned out to be a different person could be neither separated nor spared. The authorisation (MANAGER or ADMIN,
 * fresh sign-in, a reason) is enforced by the server action (app/actions/customer-identity.ts); this module takes the already-authorised user id.
 *
 * CANCEL sets the request CANCELLED, which releases the merge/unmerge block. Records ALREADY ERASED stay erased (an erasure is irreversible); nothing more is erased
 * by it. EXCLUDE removes one still-live member from the saved list (and remembers it, so a later re-resolve does not add it back); the requested customer cannot be
 * excluded (cancel instead) and the list keeps at least one member. Both write an audit entry (the reason is the operator's, ids only otherwise) under the global CRM lock.
 */
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { lockCrmIdentity } from '@/lib/domain/crm/identity-lock'

export const ERASURE_CANCELLED_ACTION = 'customer_erasure_cancelled'
export const ERASURE_MEMBER_EXCLUDED_ACTION = 'customer_erasure_member_excluded'
export const ERASURE_REASON_REQUIRED_ERROR = 'Give a reason (at least 5 characters). Nothing was changed.'

export type ErasureControlResult = { success: true } | { success: false; error: string }

const cleanReason = (reason: string): string | null => {
  const r = typeof reason === 'string' ? reason.trim() : ''
  return r.length >= 5 ? r.slice(0, 500) : null
}

export async function cancelClusterErasure(requestId: string, reason: string, userId: string): Promise<ErasureControlResult> {
  const why = cleanReason(reason)
  if (!why) return { success: false, error: ERASURE_REASON_REQUIRED_ERROR }
  return db.$transaction(async (tx): Promise<ErasureControlResult> => {
    await lockCrmIdentity(tx)
    const request = await tx.customerClusterErasure.findUnique({ where: { id: requestId } })
    if (!request) return { success: false, error: 'Erasure request not found' }
    if (request.status !== 'PENDING') return { success: false, error: 'This erasure request is not pending' }
    await tx.customerClusterErasure.update({ where: { id: requestId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByUserId: userId, memberIdentityKeys: {} } })
    const erased = await tx.customer.count({ where: { id: { in: request.memberIds }, gdprAnonymisedAt: { not: null } } })
    await logActivityInTransaction(tx, {
      entityType: 'CUSTOMER',
      entityId: request.requestedCustomerId,
      tag: 'sales',
      action: ERASURE_CANCELLED_ACTION,
      description: 'A pending person erasure was cancelled; records already erased stay erased',
      metadata: { requestId, reason: why, members: request.memberIds.length, alreadyErased: erased },
      userId,
    })
    return { success: true }
  }, { maxWait: 10_000, timeout: 30_000 })
}

export async function excludeClusterErasureMember(requestId: string, memberId: string, reason: string, userId: string): Promise<ErasureControlResult> {
  const why = cleanReason(reason)
  if (!why) return { success: false, error: ERASURE_REASON_REQUIRED_ERROR }
  return db.$transaction(async (tx): Promise<ErasureControlResult> => {
    await lockCrmIdentity(tx)
    const request = await tx.customerClusterErasure.findUnique({ where: { id: requestId } })
    if (!request) return { success: false, error: 'Erasure request not found' }
    if (request.status !== 'PENDING') return { success: false, error: 'This erasure request is not pending' }
    if (!request.memberIds.includes(memberId)) return { success: false, error: 'That customer is not part of this erasure request' }
    if (memberId === request.requestedCustomerId) return { success: false, error: 'The customer the erasure was requested for cannot be excluded: cancel the request instead' }
    if (request.memberIds.length < 2) return { success: false, error: 'An erasure request keeps at least one customer: cancel it instead' }
    const member = await tx.customer.findUnique({ where: { id: memberId }, select: { gdprAnonymisedAt: true } })
    if (!member) return { success: false, error: 'Customer not found' }
    if (member.gdprAnonymisedAt) return { success: false, error: 'This record is already erased and cannot be excluded' }
    await tx.customerClusterErasure.update({
      where: { id: requestId },
      data: { memberIds: request.memberIds.filter((id) => id !== memberId), excludedMemberIds: [...request.excludedMemberIds, memberId] },
    })
    await logActivityInTransaction(tx, {
      entityType: 'CUSTOMER',
      entityId: memberId,
      tag: 'sales',
      action: ERASURE_MEMBER_EXCLUDED_ACTION,
      description: 'A customer was excluded from a pending person erasure',
      metadata: { requestId, customerId: memberId, reason: why },
      userId,
    })
    return { success: true }
  }, { maxWait: 10_000, timeout: 30_000 })
}
