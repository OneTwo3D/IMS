'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { queueEmail } from '@/lib/email-outbox'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { quoteTodayYmd } from '@/lib/sales-quote-clock'
import { getSalesQuoteQueueData, isSalesQuoteEmailEnabled, saveSalesQuoteEmailEnabled } from '@/lib/sales-quote-email'
import {
  SALES_QUOTE_EMAIL_DISABLED_MESSAGE,
  SALES_QUOTE_EMAIL_REFERENCE_TYPE,
  SALES_QUOTE_EMAIL_SETTING_KEY,
  decideQuoteConversion,
  isQuoteExpired,
  quoteDateToYmd,
} from '@/lib/domain/sales/sales-quote'

/**
 * Sales quotations (o3d-ngmt.16): convert to order, send by email, and the Settings switch behind the email.
 *
 * A quote is a DRAFT with `isQuote` set (lib/domain/sales/sales-quote.ts), so none of these touches stock, the warehouse, the storefront or the
 * accounting ledger: converting clears the flag and nothing else (prices are not recomputed), and sending only QUEUES an email on the outbox.
 */

/**
 * One click: the quote becomes a plain DRAFT order, which the operator then confirms through the existing flow. A quote past its validity date converts only
 * with a note saying why its prices still stand; the note is appended to the order's internal notes (an erased-on-request column), not copied into the activity log.
 */
export async function convertQuoteToOrder(id: string, options?: { overrideNote?: string }): Promise<{ success: boolean; error?: string; expired?: boolean }> {
  try {
    const session = await requirePermission('sales.create')
    const today = await quoteTodayYmd()
    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, id)
      const so = await tx.salesOrder.findUnique({
        where: { id },
        select: {
          id: true, orderNumber: true, externalOrderNumber: true, status: true, isQuote: true, quoteValidUntil: true, erasedAt: true, internalNotes: true,
          _count: { select: { shoppingLinks: true } },
        },
      })
      if (!so) return { error: 'Order not found' } as const
      if (so.erasedAt) return { error: 'This order\'s personal data has been erased, so it can no longer be changed.' } as const
      const verdict = decideQuoteConversion(
        { isQuote: so.isQuote, status: so.status, quoteValidUntil: quoteDateToYmd(so.quoteValidUntil), hasExternalSource: so._count.shoppingLinks > 0 },
        today,
        options?.overrideNote,
      )
      if (!verdict.ok) return { error: verdict.error } as const
      const validUntil = quoteDateToYmd(so.quoteValidUntil)
      const stamp = verdict.expired
        ? `[Quote converted after it expired on ${validUntil}, on ${today}: ${verdict.overrideNote}]`
        : null
      // The flag and, when the quote had expired, the operator's note. NOTHING ELSE is written: the lines, prices, tax and totals stay exactly as quoted.
      await tx.salesOrder.update({
        where: { id },
        data: {
          isQuote: false,
          ...(stamp ? { internalNotes: so.internalNotes ? `${so.internalNotes}\n${stamp}` : stamp } : {}),
        },
      })
      return { ok: true as const, reference: getSalesOrderReference(so), expired: verdict.expired, validUntil }
    })
    if ('error' in outcome) return { success: false, error: outcome.error }
    try { revalidatePath('/sales'); revalidatePath(`/sales/${id}`) } catch { /* cache refresh only */ }
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'quote_converted',
      tag: 'sales',
      level: outcome.expired ? 'WARNING' : 'INFO',
      description: outcome.expired
        ? `Converted quote ${outcome.reference} to an order after it expired on ${outcome.validUntil} (an operator note is on the order's internal notes). It is a draft: confirm it to process it.`
        : `Converted quote ${outcome.reference} to an order. It is a draft: confirm it to process it.`,
      userId: session.user.id,
      metadata: { orderNumber: outcome.reference, expired: outcome.expired, quoteValidUntil: outcome.validUntil },
    })
    return { success: true, expired: outcome.expired }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Queue the quote PDF email for the customer on the email outbox (the same path as the order confirmation). Nothing is sent from here: the outbox drain
 * delivers it under the installation's SMTP settings and suppression list, and re-checks the switch at send time, so a switched-off installation delivers nothing.
 * Behind the `sales_quote_email_enabled` setting (default off): with it off nothing is queued and the operator is told to download the PDF.
 */
export async function sendQuoteEmail(id: string): Promise<{ success: boolean; error?: string; alreadyQueued?: boolean }> {
  try {
    await requirePermission('sales.process')
    const session = await auth()
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' }
    if (!(await isSalesQuoteEmailEnabled())) return { success: false, error: SALES_QUOTE_EMAIL_DISABLED_MESSAGE }

    const queued = await getSalesQuoteQueueData(id)
    if (!queued.isQuote) return { success: false, error: 'This order is not a quote.' }
    if (queued.status !== 'DRAFT') return { success: false, error: `This quote is ${queued.status} and cannot be sent.` }
    const facts = await db.salesOrder.findUnique({ where: { id }, select: { isQuote: true, quoteValidUntil: true } })
    if (facts && isQuoteExpired({ isQuote: facts.isQuote, quoteValidUntil: quoteDateToYmd(facts.quoteValidUntil) }, await quoteTodayYmd())) {
      return { success: false, error: 'This quote has expired. Move its validity date (Edit) before sending it.' }
    }

    const outcome = await queueEmail({
      kind: 'SALES_QUOTE', // SALES_QUOTE_EMAIL_KIND, spelled out so the document census sees the kind
      to: queued.to,
      subject: queued.subject,
      html: 'queued',
      referenceType: SALES_QUOTE_EMAIL_REFERENCE_TYPE,
      referenceId: id,
    })
    if (!outcome.queued && outcome.reason === 'recipient_erased') return { success: false, error: 'This order\'s personal data was erased, so no email can be sent for it.' }
    if (outcome.queued) await db.salesOrder.update({ where: { id }, data: { quoteSentAt: new Date() }, select: { id: true } })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'quote_email_queued',
      tag: 'sales',
      level: 'INFO',
      description: outcome.queued
        ? `Queued quote ${queued.reference} for the customer`
        : `Quote ${queued.reference} was already queued and undelivered — not duplicated`,
      userId: session.user.id,
    })
    try { revalidatePath(`/sales/${id}`) } catch { /* cache refresh only */ }
    return { success: true, ...(outcome.queued ? {} : { alreadyQueued: true }) }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/** The Settings > Documents switch for emailing quotes to customers (admin only). */
export async function setSalesQuoteEmailEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('settings.company')
    await saveSalesQuoteEmailEnabled(enabled === true)
    await logActivity({
      entityType: 'SETTING', entityId: SALES_QUOTE_EMAIL_SETTING_KEY, action: 'setting_changed', tag: 'settings', level: 'INFO',
      description: `Emailing quotes to customers switched ${enabled === true ? 'ON' : 'OFF'}`,
    })
    revalidatePath('/settings/company')
    revalidatePath('/sales')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
