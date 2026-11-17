/**
 * The purchase order email: the queue-time facts (recipient, subject) and the send-time body with the PO PDF attached.
 * Queued on the email outbox with kind PURCHASE_ORDER and referenceType PurchaseOrder; the outbox drain calls
 * `buildPurchaseOrderEmail`, so the address and the document are those of the order AT SEND TIME.
 */
import { db } from '@/lib/db'
import { PURCHASE_ORDER_EMAIL_SEND_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { EmailKindDisabledError } from '@/lib/email-kind-disabled'
import { PO_EMAIL_DISABLED_REASON, PO_EMAIL_SETTING_KEY } from '@/lib/domain/purchasing/po-document'
import { assertPoApprovedForSend } from '@/lib/domain/purchasing/po-approval'
import { renderEmailHtml } from '@/lib/email-template'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'
import { formatMoney } from '@/lib/utils'
import { getBranding } from '@/lib/pdf'
import { loadPurchaseOrderDocument, loadPurchaseOrderTemplate, renderPurchaseOrderPdf } from '@/lib/purchase-order-pdf'

export const PURCHASE_ORDER_EMAIL_KIND = 'PURCHASE_ORDER'
export const PURCHASE_ORDER_EMAIL_REFERENCE_TYPE = 'PurchaseOrder'

/** An order that is not (or no longer) a live order with the supplier is not mailed. */
const UNSENDABLE_STATUSES = new Set(['DRAFT', 'RFQ_SENT', 'QUOTE_RECEIVED', 'CANCELLED'])

/** The switch for emailing POs to suppliers. Absent or anything but 'true' is OFF. */
export async function isPurchaseOrderEmailEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: PO_EMAIL_SETTING_KEY }, select: { value: true } })
  return row?.value === 'true'
}

export async function getPurchaseOrderQueueData(id: string): Promise<{ reference: string; status: string; supplierEmail: string | null; subject: string }> {
  const po = await db.purchaseOrder.findUnique({ where: { id }, select: { reference: true, status: true, supplier: { select: { email: true } } } })
  if (!po) throw new Error('PO not found')
  return { reference: po.reference, status: po.status, supplierEmail: po.supplier.email, subject: `Purchase Order ${po.reference}` }
}

export async function buildPurchaseOrderEmail(id: string) {
  // Checked at SEND time, so a row queued before the switch was turned off is refused too.
  if (!(await isPurchaseOrderEmailEnabled())) throw new EmailKindDisabledError(PO_EMAIL_DISABLED_REASON)
  const [po, status] = await Promise.all([loadPurchaseOrderDocument(id), db.purchaseOrder.findUnique({ where: { id }, select: { status: true } })])
  if (!po || !status) throw new Error('PO not found')
  if (UNSENDABLE_STATUSES.has(status.status)) throw new Error(`PO ${po.reference} is ${status.status}; the purchase order email is only sent for a confirmed order`)
  // Checked at SEND time too: an order queued while approved and edited dearer since is not mailed.
  await assertPoApprovedForSend(db, id)
  const to = po.supplier.email?.trim()
  if (!to) throw new Error('No supplier email address')

  const [branding, tpl, tz] = await Promise.all([getBranding(), loadPurchaseOrderTemplate(), getDisplayTimeZone()])
  const pdf = await renderPurchaseOrderPdf(po, branding, tpl, { timeZone: tz })
  const subject = `Purchase Order ${po.reference}`
  const html = await renderEmailHtml(branding, {
    recipientName: po.supplier.contactName || po.supplier.name,
    recipientEmail: to,
    reference: po.reference,
    date: formatDateTime(po.createdAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    subject,
    bodyLines: [
      `Please find attached our purchase order ${po.reference} for ${formatMoney(po.totals.total, po.currencySymbol, po.currencySymbolPosition)}.`,
      'Please confirm receipt and your expected delivery date at your earliest convenience, and quote the PO reference on all delivery notes and invoices.',
    ],
  }, 'purchase_order')
  return { to, subject, html, attachments: [{ filename: `PO-${po.reference}.pdf`, content: pdf }], sendGuard: purchaseOrderSendGuard, sendDeadlineMs: PO_SEND_DEADLINE_MS, singleSend: true }
}

/** The PO send's own deadline (the mailer closes the connection at it) and the guard's backstop race, both well below the transaction timeout. */
export const PO_SEND_DEADLINE_MS = 60_000
const PO_SEND_BACKSTOP_MS = 75_000
const PO_SEND_TX_TIMEOUT_MS = 120_000
export const PO_SEND_UNKNOWN_OUTCOME = 'Outcome unknown: the purchase order email did not complete before the send deadline, so it may or may not have been delivered. Check with the supplier before re-sending (Email PO).'

type GuardOutcome<T> = { refused: string; unknown?: undefined } | { unknown: string; refused?: undefined } | { refused?: undefined; unknown?: undefined; value: T }

/**
 * THE DELIVERY-BOUNDARY CHECK. Runs the send inside a transaction that holds the PO email send lock SHARED and has just re-read the flag,
 * so: a switch-off committed before this point refuses the send; a switch-off that starts after it waits (exclusive lock) until the send
 * has returned. The row's settlement happens after, outside the lock. Nothing is sent on a refusal.
 *
 * THE LOCK IS BOUNDED. The send has a deadline (60 s: the mailer's transport timeouts, then its own race that CLOSES the connection) and the
 * guard races it again at 75 s; the transaction's own timeout is 120 s, so the lock is never released by the transaction timing out under a
 * live send. A send that hits a deadline settles as a terminal "outcome unknown" failure and is NEVER retried automatically, so no email can
 * go out after the lock is released and an Off save has committed: the connection is closed, and the row will not be sent again. A person
 * can re-queue it with Email PO (which re-checks the flag). An error thrown by the transaction AFTER the send returned (commit, release)
 * returns the send's answer instead of rethrowing, so a delivered email is not left retryable.
 */
export async function purchaseOrderSendGuard<T>(send: () => Promise<T>): Promise<GuardOutcome<T>> {
  return runUnderPoEmailSendLock(db, send)
}

type LockableClient = {
  $transaction: <R>(fn: (tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>; setting: { findUnique: typeof db.setting.findUnique } }) => Promise<R>, options?: { timeout?: number; maxWait?: number }) => Promise<R>
}

/** @internal exported for tests, which pass a double client. */
export async function runUnderPoEmailSendLock<T>(
  client: unknown,
  send: () => Promise<T>,
  options: { backstopMs?: number } = {},
): Promise<GuardOutcome<T>> {
  let answered: GuardOutcome<T> | null = null
  try {
    return await (client as LockableClient).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${PURCHASE_ORDER_EMAIL_SEND_LOCK_NAMESPACE}::int4, 0::int4)`
      const row = await tx.setting.findUnique({ where: { key: PO_EMAIL_SETTING_KEY }, select: { value: true } })
      if (row?.value !== 'true') return { refused: PO_EMAIL_DISABLED_REASON } as GuardOutcome<T>
      let timer: ReturnType<typeof setTimeout> | undefined
      const sending = send()
      const raced = await Promise.race([
        sending.then((value) => ({ value }) as { value: T }),
        new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), options.backstopMs ?? PO_SEND_BACKSTOP_MS) }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      if (raced === 'deadline') {
        sending.catch(() => undefined)
        answered = { unknown: PO_SEND_UNKNOWN_OUTCOME }
        return answered
      }
      answered = { value: raced.value }
      return answered
    }, { timeout: PO_SEND_TX_TIMEOUT_MS, maxWait: 30_000 })
  } catch (e) {
    // The send already answered: do not let a failure of the transaction's own commit turn a delivered or unknown email into a retryable one.
    if (answered) return answered
    throw e
  }
}

/** Save the switch. Takes the send lock EXCLUSIVE, so it waits for sends already past their check; sends after it see the new value. */
export async function savePurchaseOrderEmailEnabled(enabled: boolean): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PURCHASE_ORDER_EMAIL_SEND_LOCK_NAMESPACE}::int4, 0::int4)`
    const value = enabled ? 'true' : 'false'
    await tx.setting.upsert({ where: { key: PO_EMAIL_SETTING_KEY }, create: { key: PO_EMAIL_SETTING_KEY, value }, update: { value } })
  }, { timeout: 180_000, maxWait: 30_000 })
}
