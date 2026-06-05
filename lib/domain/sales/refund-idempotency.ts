import { Prisma } from '@/app/generated/prisma/client'

const EXTERNAL_REFUND_ID_TARGETS = new Set([
  'externalRefundId',
  'sales_order_refunds_externalRefundId_key',
])

function targetMentionsExternalRefundId(target: unknown): boolean {
  if (Array.isArray(target)) {
    return target.some((part) => targetMentionsExternalRefundId(part))
  }
  if (typeof target !== 'string') return false
  return EXTERNAL_REFUND_ID_TARGETS.has(target)
}

export function isExternalRefundIdUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  return targetMentionsExternalRefundId(error.meta?.target)
}
