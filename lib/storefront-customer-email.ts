/**
 * Customer e-mail for STOREFRONT orders, queued by IMS (o3d-zvec.24): order confirmation, partial shipment and delivered. (The "dispatched" e-mail is
 * `lib/dispatch-email.ts`, which now also covers a storefront order when the switch is on.) The rules, the switch and the single-send contract are in
 * `lib/domain/storefront-customer-email/constants.ts`; this file is the database side. NOT 'use server': it cannot be called from the client.
 *
 * Every function here NEVER THROWS (the order import, the shipment despatch and the status change that call it must not fail because a courtesy e-mail could
 * not be queued) and reads the switch FIRST, so with the switch off (the default) none of them touches anything else.
 *
 * Queued under the order row lock: the existence check (any status of the same kind) and the insert are one transaction, so concurrent despatch retries
 * (the screen and the WMS sweep) cannot both queue, while a retry after a crashed enqueue heals. A second undelivered row is also refused by the
 * database (`email_outbox_undelivered_reference_uq`); that collision is reported as `already_queued`, not as an error.
 */

import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { isUndeliveredEmailCollision } from '@/lib/email-outbox'
import { withSavepoint } from '@/lib/db/savepoint'
import { isStorefrontCustomerEmailEnabled, readStorefrontCustomerEmailEnabledAt } from '@/lib/domain/storefront-customer-email/switch'
import {
  STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY,
  STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY,
  parseStorefrontEmailEnabledAt,
  STOREFRONT_CONFIRMATION_KIND,
  STOREFRONT_DELIVERED_KIND,
  evaluateStorefrontEmailEligibility,
  storefrontPartialKind,
  type StorefrontEmailKindName,
} from '@/lib/domain/storefront-customer-email/constants'

type QueueResult = { queued: boolean; reason?: string }

const SUBJECT: Record<StorefrontEmailKindName, (ref: string) => string> = {
  confirmation: (ref) => `Order Confirmation ${ref}`,
  partial: (ref) => `Part of your order ${ref} has been dispatched`,
  delivered: (ref) => `Your order ${ref} has been delivered`,
}

/** The activity written when a held order's release is refused as history: the source of the hand-send `--paid-since` list. */
export const RELEASE_NOT_SENT_ACTION = 'storefront_confirmation_not_sent_on_release'

type EmailParams = { name: StorefrontEmailKindName; kind: string; orderId: string; shipmentId?: string; releasedAt?: Date }
type InTxOutcome = { queued: false; reason: string } | { queued: true; ref: string }

/**
 * The decision and the outbox insert for one e-mail, on a transaction the CALLER holds with the order row ALREADY LOCKED. The one body behind both the
 * stand-alone queue (own transaction) and the release claim (inside the status transaction). `skipDuplicates` turns the database's undelivered-row
 * uniqueness into "already_queued" instead of an error, which inside a caller's transaction would abort it.
 */
async function decideAndQueueUnderLock(tx: Prisma.TransactionClient, params: EmailParams, ctx: { enabledAt: Date | null; skipDuplicates: boolean }): Promise<InTxOutcome> {
  const { name, kind, orderId } = params
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      isQuote: true,
      erasedAt: true,
      customer: { select: { gdprAnonymisedAt: true } },
      customerEmail: true,
      orderNumber: true,
      externalOrderNumber: true,
      externalCreatedAt: true,
      shippedAt: true,
      createdAt: true,
      _count: { select: { shoppingLinks: true } },
    },
  })
  // Read under the order lock just taken: an erased order, or one whose customer is erased, gets no e-mail.
  if (order?.erasedAt || order?.customer?.gdprAnonymisedAt) return { queued: false, reason: 'recipient_erased' }
  const shipment = params.shipmentId
    ? await tx.shipment.findUnique({ where: { id: params.shipmentId }, select: { status: true, shippedAt: true, orderId: true } })
    : null
  // ANY status of this kind counts: a FAILED row (an unknown outcome included) is not queued again automatically. A person re-sends it.
  const existing = await tx.emailOutbox.findFirst({ where: { kind, referenceType: 'SalesOrder', referenceId: orderId }, select: { id: true } })
  const eligibility = evaluateStorefrontEmailEligibility({
    kind: name,
    settingValue: 'true',
    enabledAt: ctx.enabledAt,
    now: new Date(),
    orderId,
    order: order
      ? {
        status: order.status,
        isQuote: order.isQuote,
        customerEmail: order.customerEmail,
        shoppingLinkCount: order._count.shoppingLinks,
        placedAt: order.externalCreatedAt ?? order.createdAt,
        shippedAt: order.shippedAt,
        releasedAt: params.releasedAt ?? null,
      }
      : null,
    shipment,
    alreadyQueued: existing !== null,
  })
  if (!eligibility.eligible) return { queued: false, reason: eligibility.reason }

  const ref = order!.orderNumber ?? order!.externalOrderNumber ?? orderId.slice(0, 8)
  const data = {
    kind,
    toEmail: order!.customerEmail!.trim().toLowerCase(),
    subject: SUBJECT[name](ref),
    html: 'queued',
    referenceType: 'SalesOrder',
    referenceId: orderId,
  }
  // Inside a caller's transaction the insert runs in a savepoint: a collision on the undelivered-row index (a writer the order lock does not serialise) is
  // "already_queued" and must not abort the caller's transaction. A stand-alone queue throws it and the caller maps it.
  const insert = () => tx.emailOutbox.create({ data })
  if (ctx.skipDuplicates) {
    try {
      await withSavepoint(tx, insert)
    } catch (error) {
      if (isUndeliveredEmailCollision(error)) return { queued: false, reason: 'already_queued' }
      throw error
    }
  } else {
    await insert()
  }
  return { queued: true, ref }
}

async function recordQueued(name: StorefrontEmailKindName, kind: string, orderId: string, ref: string): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'storefront_customer_email_queued',
    tag: 'sales',
    level: 'INFO',
    description: `Queued ${name} e-mail for storefront order ${ref}`,
    metadata: { kind },
    resolveUser: false,
  })
}

async function queueStorefrontEmail(params: EmailParams): Promise<QueueResult> {
  const { name, kind, orderId } = params
  try {
    if (!(await isStorefrontCustomerEmailEnabled())) return { queued: false, reason: 'disabled' }
    // The switch-on instant anchors every history guard; read with the switch, before the order lock.
    const enabledAt = await readStorefrontCustomerEmailEnabledAt()

    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      return decideAndQueueUnderLock(tx, params, { enabledAt, skipDuplicates: false })
    })
    if (!outcome.queued) return outcome

    await recordQueued(name, kind, orderId, outcome.ref)
    return { queued: true }
  } catch (error) {
    // The database refused a second undelivered row for this (kind, order): a writer the order lock does not serialise, which is what the index is for.
    if (isUndeliveredEmailCollision(error)) return { queued: false, reason: 'already_queued' }
    await recordQueueFailure(name, orderId, error)
    return { queued: false, reason: 'error' }
  }
}

export type ReleaseClaimResult = { claimed: boolean; queued: boolean; reason?: string; afterCommit: (() => Promise<void>) | null }

/**
 * THE RELEASE CLAIM, ON THE CALLER'S TRANSACTION (order row already locked by the caller). A storefront order imported HELD carries a one-shot marker
 * (`confirmationOnReleasePendingAt`); the first move of it to a despatch-pending status consumes it and, in the SAME transaction, judges and queues the
 * confirmation, so a crash can neither consume the marker with nothing queued nor leave it armed after the status moved. The claim is one atomic
 * `updateMany` (count === 1): of any number of racing moves exactly one wins. It runs AFTER the caller's own eligibility (the status write it belongs to),
 * and a refused confirmation (switch off, too old, placed before the switch-on) still consumes the marker, so it can never fire later.
 * `afterCommit` records the activity once the transaction has committed (null when nothing was queued).
 */
export async function claimAndQueueConfirmationOnReleaseInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  options?: { releasedAt?: Date },
): Promise<ReleaseClaimResult> {
  const claim = await tx.salesOrder.updateMany({ where: { id: orderId, confirmationOnReleasePendingAt: { not: null } }, data: { confirmationOnReleasePendingAt: null } })
  if (claim.count !== 1) return { claimed: false, queued: false, reason: 'no_marker', afterCommit: null }
  // A refusal of the release is recorded durably, in this transaction, for the step W hand-send lists (`npm run storefront:hand-send`):
  //   before_switch_on  the order predates the switch-on: WooCommerce confirmed it, or owed it and no longer sends it.
  //   disabled          the switch was still off at the release (before the switch-on, so possibly after natives-off): recorded always; the lists tell a payment
  //                     WooCommerce confirmed natively (before natives-off) from one nobody confirmed by the recorded PAID time.
  // `paidObserved` is true only when the store reported the paid time (the full-bypass sync path); an IMS-side release carries none and is NEVER listed as paid.
  // `too_old` is deliberately not recorded: an order placed after the switch-on and released in IMS long after its placement is IMS's own to confirm and it
  // chooses not to (runbook step W); nothing is hand-sent for it.
  const record = async (reason: string) => {
    await logActivityInTransaction(tx, {
      userId: null,
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: RELEASE_NOT_SENT_ACTION,
      tag: 'sales',
      level: 'INFO',
      description: `The order confirmation was not queued on release (${reason}); ${options?.releasedAt ? 'the store reported it paid' : 'no payment was reported by the store'}.`,
      metadata: { reason, paidObserved: options?.releasedAt !== undefined, ...(options?.releasedAt ? { releasedAt: options.releasedAt.toISOString() } : {}) },
    })
  }
  const switchRow = await tx.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY }, select: { value: true } })
  if (switchRow?.value !== 'true') {
    await record('disabled')
    return { claimed: true, queued: false, reason: 'disabled', afterCommit: null }
  }
  const stampRow = await tx.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY }, select: { value: true } })
  const outcome = await decideAndQueueUnderLock(tx, {
    name: 'confirmation', kind: STOREFRONT_CONFIRMATION_KIND, orderId, ...(options?.releasedAt ? { releasedAt: options.releasedAt } : {}),
  }, { enabledAt: parseStorefrontEmailEnabledAt(stampRow?.value), skipDuplicates: true })
  if (!outcome.queued) {
    if (outcome.reason === 'before_switch_on') await record('before_switch_on')
    return { claimed: true, queued: false, reason: outcome.reason, afterCommit: null }
  }
  return { claimed: true, queued: true, afterCommit: () => recordQueued('confirmation', STOREFRONT_CONFIRMATION_KIND, orderId, outcome.ref).catch(() => undefined) }
}

/**
 * A WooCommerce `processing` (the order is paid) for an order IMS already moved on to ALLOCATED / PICKING / PACKING while it was still held in the store
 * (the import auto-allocated a pending-payment order): the state machine refuses that move, so the hook in the status change never runs. This is the
 * release for it: claim the marker and queue the confirmation, in one transaction. Nothing to claim = nothing happens. Never throws.
 */
export async function releaseStorefrontConfirmationOnPaid(orderId: string, options?: { releasedAt?: Date }): Promise<QueueResult> {
  try {
    const outcome = await db.$transaction(async (tx) => {
      await lockSalesOrder(tx, orderId)
      const now = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      if (!now || !['ALLOCATED', 'PICKING', 'PACKING'].includes(now.status)) return null
      return claimAndQueueConfirmationOnReleaseInTx(tx, orderId, options)
    })
    if (!outcome) return { queued: false, reason: 'wrong_status' }
    if (outcome.afterCommit) await outcome.afterCommit()
    return { queued: outcome.queued, ...(outcome.reason ? { reason: outcome.reason } : {}) }
  } catch (error) {
    await recordQueueFailure('confirmation', orderId, error)
    return { queued: false, reason: 'error' }
  }
}

/**
 * A storefront e-mail that could not be queued is BEST EFFORT by design: the order import, the shipment despatch and the status change that called
 * it must not fail because a courtesy e-mail could not be queued, so the failure is returned (`reason: 'error'`), never thrown. It is not silent:
 * it is logged and written to the order's activity at WARNING (`logActivity` never throws). Nothing re-queues it automatically except a later
 * run of the same step (a despatch retry re-runs the partial-shipment and dispatched hooks and heals a crashed enqueue); otherwise the customer
 * misses this one e-mail and an operator can send it by hand.
 */
async function recordQueueFailure(name: StorefrontEmailKindName, orderId: string, error: unknown): Promise<void> {
  console.error(`Failed to queue storefront ${name} e-mail for order ${orderId}`, error)
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'storefront_customer_email_queue_failed',
    tag: 'sales',
    level: 'WARNING',
    description: `Could not queue the ${name} e-mail for this storefront order (${error instanceof Error ? error.message : String(error)}). The order was not affected. `
      + 'Only a later run of the same step (a despatch retry) queues it again; otherwise the customer misses this one e-mail and an operator can send it by hand.',
    metadata: { kind: name },
    resolveUser: false,
  })
}

/**
 * After the order is imported from the storefront, or (`releasedAt`) after an order that was imported held (PENDING_PAYMENT / ON_HOLD) moved to processing:
 * WooCommerce sent its confirmation on that move and is off by then, so the release is the moment the customer is owed one. Same kind, same single-send
 * dedupe, so an order confirmed at import is never confirmed again at release.
 */
export function queueStorefrontConfirmationIfEligible(orderId: string, options?: { releasedAt?: Date }): Promise<QueueResult> {
  return queueStorefrontEmail({ name: 'confirmation', kind: STOREFRONT_CONFIRMATION_KIND, orderId, ...(options?.releasedAt ? { releasedAt: options.releasedAt } : {}) })
}

/**
 * THE PARTIAL-SHIPMENT E-MAIL OF ONE EXTERNAL DISPATCH BATCH. An external (WMS / storefront) dispatch ships an order's open shipments one after another; a
 * partial e-mail judged shipment by shipment ("the rest will follow") is FALSE for every shipment but the last, because the order only reaches SHIPPED when
 * the last one has left. So the loop defers the per-shipment hook (`deferStorefrontPartialEmail`) and this runs ONCE after the whole batch has been applied:
 * each shipment of the batch is judged against the order as it stands NOW (the partial rule needs the order still awaiting despatch, so an order that reached
 * SHIPPED in the batch gets no partial e-mail, only the dispatched one). Never throws.
 */
export async function queueStorefrontPartialShipmentEmailsAfterBatch(shipmentIds: readonly string[]): Promise<void> {
  for (const shipmentId of shipmentIds) await queueStorefrontPartialShipmentEmailIfEligible(shipmentId)
}

/** After one shipment of an order that still owes more has despatched. One e-mail per shipment. */
export async function queueStorefrontPartialShipmentEmailIfEligible(shipmentId: string): Promise<QueueResult> {
  let orderIdOfShipment: string | null = null
  try {
    if (!(await isStorefrontCustomerEmailEnabled())) return { queued: false, reason: 'disabled' }
    const shipment = await db.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } })
    if (!shipment) return { queued: false, reason: 'shipment_not_found' }
    orderIdOfShipment = shipment.orderId
    return await queueStorefrontEmail({ name: 'partial', kind: storefrontPartialKind(shipmentId), orderId: shipment.orderId, shipmentId })
  } catch (error) {
    // Reached only when the switch read or the shipment lookup threw (queueStorefrontEmail never throws). With no order id there is no order to
    // note it on, so it is logged at SYSTEM level and the shipment's own despatch retry queues the e-mail again.
    if (orderIdOfShipment) await recordQueueFailure('partial', orderIdOfShipment, error)
    else {
      console.error(`Failed to queue storefront partial-shipment e-mail for shipment ${shipmentId}`, error)
      await logActivity({
        entityType: 'SYSTEM',
        entityId: shipmentId,
        action: 'storefront_customer_email_queue_failed',
        tag: 'sales',
        level: 'WARNING',
        description: `Could not queue the partial-shipment e-mail for shipment ${shipmentId} (${error instanceof Error ? error.message : String(error)}). The despatch was not affected; a despatch retry queues it again, otherwise the customer misses this one e-mail and an operator can send it by hand.`,
        metadata: { kind: 'partial', shipmentId },
        resolveUser: false,
      })
    }
    return { queued: false, reason: 'error' }
  }
}

/** After the order is marked DELIVERED. */
export function queueStorefrontDeliveredEmailIfEligible(orderId: string): Promise<QueueResult> {
  return queueStorefrontEmail({ name: 'delivered', kind: STOREFRONT_DELIVERED_KIND, orderId })
}
