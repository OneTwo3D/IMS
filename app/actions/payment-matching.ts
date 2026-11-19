'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requirePermission, requireRole } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { serializeSettingValue } from '@/lib/settings-store'
import {
  PAYMENT_MATCHING_MODE_KEY,
  PAYMENT_MATCHING_MODES,
  describePaymentMatchReason,
  getPaymentMatchingMode,
  type PaymentMatchingMode,
} from '@/lib/domain/accounting/payment-matching'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { businessDateYmd } from '@/lib/business-date'

/**
 * SYNC > PAYMENT MATCHING: what the customer-payment matching pass (lib/domain/accounting/payment-matching.ts) decided for each receipt that was never registered in Xero.
 *
 * Reading is the `sync` permission, the same gate as every other accounting-sync read. Changing the MODE is `sync` AND the ADMIN role: it decides whether IMS posts customer payments to Xero, the
 * same stricter frame as the connector credentials. The mode defaults to off and is never changed by anything but this action.
 */

const PAGE_SIZE = 200

export type PaymentMatchRow = {
  id: string
  paymentId: string
  orderId: string
  orderReference: string
  status: 'WOULD_POST' | 'UNMATCHED' | 'BLOCKED' | 'CLAIMED' | 'REGISTERED' | 'FAILED'
  reason: string | null
  reasonText: string
  detail: string | null
  bankAccountId: string | null
  amount: string
  currency: string
  amountDue: string | null
  accountingInvoiceId: string | null
  paymentDate: string | null
  lastEvaluatedAt: string
  attempts: number
}
export type PaymentMatchingOverview = {
  mode: PaymentMatchingMode
  counts: Record<PaymentMatchRow['status'], number>
  rows: PaymentMatchRow[]
  total: number
}

/** Everything that is not yet registered, the ones needing a person first (failed, blocked, unmatched), then what live would post. */
export async function getPaymentMatchingOverview(): Promise<PaymentMatchingOverview> {
  await requirePermission('sync')
  const where = { status: { not: 'REGISTERED' as const } }
  const [mode, grouped, total, found] = await Promise.all([
    getPaymentMatchingMode(),
    db.xeroPaymentMatch.groupBy({ by: ['status'], _count: { _all: true } }),
    db.xeroPaymentMatch.count({ where }),
    db.xeroPaymentMatch.findMany({ where, orderBy: [{ status: 'asc' }, { lastEvaluatedAt: 'desc' }, { id: 'asc' }], take: PAGE_SIZE }),
  ])
  const orders = await db.salesOrder.findMany({
    where: { id: { in: [...new Set(found.map((r) => r.orderId))] } },
    select: { id: true, orderNumber: true, externalOrderNumber: true },
  })
  const byOrder = new Map(orders.map((o) => [o.id, getSalesOrderReference(o)]))
  const counts: PaymentMatchingOverview['counts'] = { WOULD_POST: 0, UNMATCHED: 0, BLOCKED: 0, CLAIMED: 0, REGISTERED: 0, FAILED: 0 }
  for (const g of grouped) counts[g.status] = g._count._all
  const rows = found.map((r): PaymentMatchRow => ({
    id: r.id,
    paymentId: r.paymentId,
    orderId: r.orderId,
    orderReference: byOrder.get(r.orderId) ?? r.orderId,
    status: r.status,
    reason: r.reason,
    reasonText: describePaymentMatchReason(r.reason),
    detail: r.detail,
    bankAccountId: r.bankAccountId,
    amount: r.amount.toFixed(2),
    currency: r.currency,
    amountDue: r.amountDue === null ? null : r.amountDue.toFixed(2),
    accountingInvoiceId: r.accountingInvoiceId,
    paymentDate: r.paymentDate ? businessDateYmd(r.paymentDate) : null,
    lastEvaluatedAt: r.lastEvaluatedAt.toISOString(),
    attempts: r.attempts,
  }))
  return { mode, counts, rows, total }
}

export async function setPaymentMatchingMode(mode: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sync')
  const session = await requireRole('ADMIN')
  if (!(PAYMENT_MATCHING_MODES as readonly string[]).includes(mode)) return { success: false, error: 'Mode must be off, shadow or live.' }
  const before = await getPaymentMatchingMode()
  await db.setting.upsert({
    where: { key: PAYMENT_MATCHING_MODE_KEY },
    create: { key: PAYMENT_MATCHING_MODE_KEY, value: serializeSettingValue(PAYMENT_MATCHING_MODE_KEY, mode) },
    update: { value: serializeSettingValue(PAYMENT_MATCHING_MODE_KEY, mode) },
  })
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_payment_matching_mode_changed',
    tag: 'sync',
    description: `Xero payment matching mode changed from ${before} to ${mode}`,
    metadata: { from: before, to: mode, userId: session.user.id },
  })
  revalidatePath('/sync/payment-matching')
  return { success: true }
}
