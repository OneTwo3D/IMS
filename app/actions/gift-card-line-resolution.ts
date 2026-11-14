'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { readEuVatRegimeStamp } from '@/lib/domain/accounting/eu-vat-regime-stamp'
import { heldSalesInvoiceQueueWhere, isHeldSalesInvoicePayload } from '@/lib/connectors/woocommerce/sync/held-sales-invoice'
import { GIFT_CARD_RESOLUTION_CONNECTOR, currentGiftCardStoreIdentity, giftCardUnsettledHoldWhere } from '@/lib/connectors/woocommerce/sync/gift-card-line-resolution'

/**
 * SYNC > EXCEPTIONS: GIFT-CARD ANSWERS FOR ORDER LINES THE STORE COULD NOT SETTLE.
 *
 * An order whose invoice the EU VAT treatment refused for `gift_card_flag_missing` is parked as a held invoice that names the unsettled WooCommerce line item ids. This lists them and takes the operator's answer
 * for each (a gift card, or not). The answer is recorded with who and when (gift-card-line-resolution.ts) and the regime builder uses it on the next import of the order. Taking it needs the sync permission and a
 * fresh sign-in, like the other accounting answers on this page.
 */

export type GiftCardLineRow = {
  externalLineItemId: number
  description: string
  sku: string | null
  quantity: string
  /** The operator's recorded answer: true a gift card, false not a gift card, null none yet. */
  answer: boolean | null
  answeredAt: string | null
  answeredBy: string | null
}
export type GiftCardOrderRow = { salesOrderId: string; orderNumber: string; externalOrderId: string; lines: GiftCardLineRow[] }

/** Orders per page of the section. */
const GIFT_CARD_PAGE_SIZE = 50

export type GiftCardLinePage = { rows: GiftCardOrderRow[]; total: number; page: number; pageSize: number }

function lineIdsOf(payload: unknown): number[] {
  if (!isHeldSalesInvoicePayload(payload)) return []
  const marker = payload.accountingPayload[EU_VAT_TREATMENT_PAYLOAD_KEY] as { reason?: unknown; giftCardLineIds?: unknown } | null | undefined
  if (marker?.reason !== 'treatment_refused' || !Array.isArray(marker.giftCardLineIds)) return []
  return marker.giftCardLineIds.filter((id): id is number => Number.isInteger(id))
}

/** The held invoices refused for an unsettled gift-card flag, with each such line and any answer already given. */
export async function listGiftCardLinesToResolve(pageInput = 0): Promise<GiftCardLinePage> {
  await requirePermission('sync')
  const page = Number.isInteger(pageInput) && pageInput > 0 ? pageInput : 0
  // The filter is in the database and the page is cut AFTER it, so unrelated refusals can never hide an order that can be answered; every matching order is reachable by paging.
  const where = giftCardUnsettledHoldWhere()
  const [total, held] = await Promise.all([
    db.shoppingSyncLog.count({ where }),
    db.shoppingSyncLog.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * GIFT_CARD_PAGE_SIZE, take: GIFT_CARD_PAGE_SIZE, select: { payload: true } }),
  ])
  const storeIdentity = await currentGiftCardStoreIdentity()
  const rows: GiftCardOrderRow[] = []
  for (const row of held) {
    const ids = lineIdsOf(row.payload)
    if (ids.length === 0 || !isHeldSalesInvoicePayload(row.payload)) continue
    const { salesOrderId, orderNumber, externalOrderId } = row.payload
    const [lines, answers] = await Promise.all([
      db.salesOrderLine.findMany({ where: { orderId: salesOrderId, externalLineItemId: { in: ids } }, select: { externalLineItemId: true, description: true, sku: true, qty: true } }),
      db.euVatGiftCardLineResolution.findMany({ where: { connector: GIFT_CARD_RESOLUTION_CONNECTOR, storeIdentity: storeIdentity ?? '', externalOrderId, externalLineItemId: { in: ids } }, select: { externalLineItemId: true, isGiftCard: true, resolvedAt: true, resolvedByUserId: true } }),
    ])
    const users = await db.user.findMany({ where: { id: { in: [...new Set(answers.map((a) => a.resolvedByUserId))] } }, select: { id: true, name: true } })
    const byLine = new Map(lines.map((l) => [l.externalLineItemId, l]))
    rows.push({
      salesOrderId, orderNumber, externalOrderId,
      lines: ids.map((id) => {
        const line = byLine.get(id)
        const answer = answers.find((a) => a.externalLineItemId === id)
        return {
          externalLineItemId: id,
          description: line?.description ?? `Line ${id}`,
          sku: line?.sku ?? null,
          quantity: line ? line.qty.toString() : '',
          answer: answer?.isGiftCard ?? null,
          answeredAt: answer ? answer.resolvedAt.toISOString() : null,
          answeredBy: answer ? users.find((u) => u.id === answer.resolvedByUserId)?.name ?? null : null,
        }
      }),
    })
  }
  return { rows, total, page, pageSize: GIFT_CARD_PAGE_SIZE }
}

export type ResolveGiftCardLineResult = { success: boolean; error?: string; notice?: string } | FreshAuthFailureResult

/**
 * Record whether one unsettled order line is a gift card. Refused unless the order is still held for exactly that line (so an answer cannot be filed for a line nothing is waiting on) and its EU VAT regime is not
 * already decided (the decision is final, so a later answer could not change it).
 */
export async function resolveGiftCardLineAction(salesOrderId: string, externalLineItemId: number, isGiftCard: boolean): Promise<ResolveGiftCardLineResult> {
  try {
    const session = await requireFreshPermission('sync')
    if (typeof salesOrderId !== 'string' || salesOrderId === '' || !Number.isInteger(externalLineItemId) || typeof isGiftCard !== 'boolean') return { success: false, error: 'No order line was named.' }
    const storeIdentity = await currentGiftCardStoreIdentity()
    if (storeIdentity === null) return { success: false, error: 'The WooCommerce store this order belongs to cannot be identified, so an answer cannot be recorded.' }
    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, salesOrderId)
      if ((await readEuVatRegimeStamp(tx, salesOrderId)) !== null) return { ok: false as const, error: 'This order’s EU VAT treatment is already decided, so an answer for its lines would change nothing.' }
      const held = await tx.shoppingSyncLog.findFirst({ where: heldSalesInvoiceQueueWhere({ salesOrderId }), orderBy: { createdAt: 'desc' }, select: { payload: true } })
      if (!held || !lineIdsOf(held.payload).includes(externalLineItemId)) return { ok: false as const, error: 'This line is not waiting for a gift-card answer. Reload the page.' }
      if (!isHeldSalesInvoicePayload(held.payload)) return { ok: false as const, error: 'This line is not waiting for a gift-card answer. Reload the page.' }
      const { externalOrderId, orderNumber } = held.payload
      const key = { connector: GIFT_CARD_RESOLUTION_CONNECTOR, storeIdentity, externalOrderId, externalLineItemId }
      const previous = await tx.euVatGiftCardLineResolution.findUnique({ where: { connector_storeIdentity_externalOrderId_externalLineItemId: key }, select: { isGiftCard: true } })
      await tx.euVatGiftCardLineResolution.upsert({
        where: { connector_storeIdentity_externalOrderId_externalLineItemId: key },
        create: { ...key, isGiftCard, resolvedByUserId: session.user.id },
        update: { isGiftCard, resolvedByUserId: session.user.id, resolvedAt: new Date() },
      })
      await logActivityInTransaction(tx, {
        userId: session.user.id,
        entityType: 'SALES_ORDER',
        entityId: salesOrderId,
        action: 'eu_vat_gift_card_line_answered',
        tag: 'accounting',
        level: 'INFO',
        description: `Line ${externalLineItemId} of WooCommerce order ${orderNumber} was marked ${isGiftCard ? 'a gift card' : 'not a gift card'}${previous ? ` (it was marked ${previous.isGiftCard ? 'a gift card' : 'not a gift card'})` : ''}.`,
        metadata: { connector: GIFT_CARD_RESOLUTION_CONNECTOR, externalOrderId, externalLineItemId, isGiftCard, previous: previous?.isGiftCard ?? null },
      })
      return { ok: true as const }
    }, { maxWait: 5_000, timeout: 20_000 })
    if (!outcome.ok) return { success: false, error: outcome.error }
    revalidatePath('/sync/exceptions')
    return { success: true, notice: 'Saved. Re-import the order from WooCommerce so its invoice is checked again with this answer.' }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
