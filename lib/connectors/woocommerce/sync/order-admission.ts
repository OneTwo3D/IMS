/**
 * WHICH ORDERS MAY IMS TAKE ON, AND WHAT REACHES THE ONES IT TURNED AWAY — the settings half of
 * the `wc_sync_order_statuses` admission boundary, and the durable retry queue behind it
 * (o3d-tj6v r4, r5).
 *
 * The RULE is pure and lives in `../order-status-filter` (`isWcOrderAdmittedByStatus`). This
 * module holds the two things the rule needs a database for.
 *
 * 1. THE SETTINGS READ, so the rule is resolved in exactly one place. Round 3 resolved it in
 *    `webhooks.ts` only, and the withdrawal-recovery sweep — which re-reads an order BY ID, with
 *    no status query and no cursor — imported past it. Round 4 gave the sweep the same resolver
 *    and left `retryPendingWcOrdersWaitingForFx` doing exactly the same thing with a stored
 *    snapshot. The answer to "which route forgot?" is that no route gets to decide any more:
 *    `importWcOrder` resolves admission ITSELF, at the pivot, and a caller can only opt OUT by
 *    proving it already asked WooCommerce for `?status=<selection>`. See `ImportWcOrderOptions`.
 *
 * 2. THE REFUSAL QUEUE. A refusal is ACKNOWLEDGED — WooCommerce's retries are finite and a
 *    redelivery re-hits the identical rule — and acknowledging stops redelivery for good. Round 4
 *    made recovery depend on the PULL CURSORS: a refusal does not advance them, and a widening of
 *    the selection rewinds them to a watermark. That is a real mechanism and it is kept, but it
 *    is not a guarantee, because it only reaches an order that a `?modified_after=` sweep still
 *    returns. Everything else about the refusal is permanent:
 *
 *      - the next ADMITTED delivery advances the cursor past the refused order;
 *      - the rewind fires only when the stored selection FINGERPRINT proves a widening, so a
 *        refusal recorded before any sweep has written one is never reached;
 *      - a delivery refused because it lost a race to a concurrent create — the pivot read "IMS
 *        does not hold this order" and the create committed a moment later — is refused against
 *        an order IMS DOES hold, which the whole design says is never gated.
 *
 *    So a refusal now leaves the same kind of signal a withdrawal does: a durable row naming the
 *    ORDER, drained BY ID, which no cursor and no `?status=` query can hide. The withdrawal sweep
 *    cron drains it every fifteen minutes; `drainWcOrderAdmissionRefusals` re-reads the live order
 *    and puts it back through the ordinary gated importer, so one code path answers all three
 *    cases — still excluded (row stays), now admitted (imported), already held because a
 *    concurrent create won (updated, row resolved).
 *
 *    AND THE ACKNOWLEDGEMENT IS CONDITIONAL ON THAT ROW (r14). Every sentence above is an argument
 *    for ACKing a refusal *because* the queue row exists. Writing the row and ACKing regardless of
 *    whether it landed keeps the ACK and throws away its justification — so the recorder returns
 *    whether the row is readable, and a refusal that could not be recorded is reported as a
 *    retryable failure instead. All three reasons share the recorder and the one exit in
 *    `refuseWcOrderCreate`, so all three are covered by that.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  isWcOrderAdmittedByStatus,
  parseWcSyncOrderStatuses,
  WC_SYNC_ORDER_STATUSES_SETTING_KEY,
} from '../order-status-filter'
import type { WcFullOrder } from './types'

export type WcOrderCreateAdmission = {
  /** May an order IMS has NEVER SEEN be created from this payload? */
  admitted: boolean
  /** The operator's current selection, for the operator-facing message. */
  configured: string[]
}

/**
 * Read the selection and judge this payload's CURRENT status against it.
 *
 * Settings only: no link lookup, no order lookup, nothing that could go stale between here and
 * the create it governs. Called from `importWcOrder`, immediately after the read that decides
 * create-versus-update, because that read is the one authority on "does IMS already hold this?"
 * and asking it twice is what made the pivot raceable.
 */
export async function resolveWcOrderCreateAdmission(
  wcOrder: Pick<WcFullOrder, 'status'>,
): Promise<WcOrderCreateAdmission> {
  const { getWithdrawalStatuses } = await import('./withdrawal')
  const [setting, withdrawal] = await Promise.all([
    db.setting.findUnique({ where: { key: WC_SYNC_ORDER_STATUSES_SETTING_KEY } }),
    getWithdrawalStatuses(),
  ])
  const configured = parseWcSyncOrderStatuses(setting?.value)
  return {
    admitted: isWcOrderAdmittedByStatus(wcOrder.status, configured, withdrawal),
    configured,
  }
}

// ---------------------------------------------------------------------------
// The durable refusal queue
// ---------------------------------------------------------------------------

/** Discriminator on the queue row's payload, so this queue and the pending-FX queue stay disjoint. */
export const WC_ADMISSION_REFUSAL_QUEUE = 'wc_order_admission_refusal'

/**
 * WHY a create was withheld. All three are ACKNOWLEDGED decisions rather than failures.
 *
 * The two STATUS reasons are resolved by the operator changing a setting that fires no WooCommerce
 * webhook — which is exactly why neither may depend on another delivery arriving. The CURRENCY
 * reason is resolved at the source instead, and depends on the same by-id re-read for the same
 * reason: the delivery that carried the unreadable payload was acknowledged, so a corrected order
 * is only ever seen again because this queue goes and looks.
 */
export type WcAdmissionRefusalReason =
  /** The order's status is outside the "Import order statuses" selection. */
  | 'status_not_admitted'
  /** Neither a mapping row nor a built-in default says what this WooCommerce status means. */
  | 'status_not_mapped'
  /**
   * WooCommerce stated no usable currency for the order — the field was absent, blank, or not a
   * three-letter code. IMS will not supply one (o3d-batch-ret r13, Codex HIGH): the currency
   * decides the FX rate, the ledger the invoice posts in and the bank account a payment settles
   * into, and a guess there is wrong in a way nothing downstream can detect.
   */
  | 'currency_missing'

export type WcAdmissionRefusalPayload = {
  queue: typeof WC_ADMISSION_REFUSAL_QUEUE
  reason: WcAdmissionRefusalReason
  connector: 'woocommerce'
  externalOrderId: string
  externalOrderNumber: string
  status: string
  configured: string[]
  /**
   * The currency EXACTLY as WooCommerce stated it, including the blank or absent value that caused
   * a `currency_missing` refusal — an operator cannot fix a field without being told what IMS read
   * in it. Optional only because rows written before r13 do not carry it.
   */
  currency?: string
  /** When the boundary FIRST turned this order away. Preserved across re-refusals. */
  refusedAt: string
  attempts: number
}

export function wcAdmissionRefusalQueueWhere(externalOrderId?: string): Prisma.ShoppingSyncLogWhereInput {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    ...(externalOrderId ? { externalId: externalOrderId } : {}),
    payload: {
      path: ['queue'],
      equals: WC_ADMISSION_REFUSAL_QUEUE,
    },
  }
}

export function isWcAdmissionRefusalPayload(payload: unknown): payload is WcAdmissionRefusalPayload {
  return typeof payload === 'object'
    && payload !== null
    && (payload as { queue?: unknown }).queue === WC_ADMISSION_REFUSAL_QUEUE
    && (payload as { connector?: unknown }).connector === 'woocommerce'
    && typeof (payload as { externalOrderId?: unknown }).externalOrderId === 'string'
    && (payload as { externalOrderId?: string }).externalOrderId !== ''
}

function refusalDescription(
  reason: WcAdmissionRefusalReason,
  status: string,
  configured: string[],
  currency: string,
): string {
  if (reason === 'currency_missing') {
    // Quotes the raw value rather than describing it, because "blank" and "absent" are different
    // faults at the source and the operator is the one who has to tell them apart.
    return `WooCommerce stated no usable currency for this order (IMS read ${currency === '' ? 'an empty value' : `"${currency}"`}), `
      + 'so it was not imported. IMS will not assume one: the currency decides the FX rate, the '
      + 'ledger the invoice posts in and the bank account a payment settles into. Check the order '
      + 'in WooCommerce — a currency missing from the API response usually means a degraded or '
      + 'filtered REST response rather than an order without a price. This row is re-checked by '
      + 'order id every 15 minutes and imports itself as soon as the order states its currency.'
  }
  return reason === 'status_not_admitted'
    ? `Status "${status}" is not in the "Import order statuses" selection `
      + `(${configured.length > 0 ? configured.join(', ') : 'none selected'}), so the order was not imported. `
      + 'Tick the status to import it; this row is re-checked by order id every 15 minutes.'
    : `IMS has no reading of the WooCommerce status "${status}" — there is no status mapping row for it `
      + 'and it is not one of WooCommerce’s own statuses, so the order was not imported rather than '
      + 'created in an invented status. Add a mapping under Sync -> WooCommerce -> Status Mappings; '
      + 'this row is re-checked by order id every 15 minutes.'
}

/**
 * Whether the refusal is DURABLY RECORDED — the caller's licence to acknowledge the delivery.
 *
 * `persisted: false` is not advisory. It means the by-id queue row the whole recovery design rests
 * on is not there, so the refusal must be reported as a retryable FAILURE and WooCommerce must be
 * allowed to send the order again. See `recordWcOrderAdmissionRefusal`.
 */
export type WcAdmissionRefusalRecord =
  | { persisted: true; id: string }
  | { persisted: false; reason: string }

/**
 * Record — durably, by order id — that the admission boundary turned an order away.
 *
 * IT RETURNS WHETHER THE ROW IS ACTUALLY THERE, and the caller acknowledges only if it is
 * (o3d-batch-ret r14, Codex HIGH). This used to catch every failure, return `void`, and let the
 * caller ACK regardless, on the argument that turning an acknowledged skip into a retried failure
 * would burn WooCommerce's finite retries down to a dead letter for an order the operator excluded
 * on purpose.
 *
 * THAT ARGUMENT IS TRUE ONLY WHILE THE ROW EXISTS. With the row written, a redelivery re-hits the
 * identical rule and the by-id drain owns the order, so re-ACKing is exactly right. With the write
 * failed it inverts into the worst outcome the module has: WooCommerce stops redelivering, the
 * drain has nothing to read, and the only recovery left is the cursor rewind — which the header
 * above already establishes is not a guarantee (the next admitted delivery advances the cursor past
 * the order, and a refusal recorded before any sweep wrote a selection fingerprint is never
 * reached). A transient statement failure would therefore lose the order silently and permanently.
 *
 * So it still NEVER THROWS — the caller decides what a failure means — but it no longer HIDES: a
 * failure comes back as `persisted: false`, and `refuseWcOrderCreate` turns that into
 * `success: false`, which the webhook reports as a 5xx the shared inbox classifies as retryable.
 *
 * CONFIRMED WITH THE DRAIN'S OWN PREDICATE, not by the write returning. A write that commits a row
 * `drainWcOrderAdmissionRefusals` cannot select — wrong status, a payload the queue filter does not
 * match — is worth exactly as much as no write at all, so the confirmation re-reads through
 * `wcAdmissionRefusalQueueWhere`, which is the query the drain itself runs.
 *
 * Idempotent per order: a re-refusal updates the existing row and keeps its original `refusedAt`,
 * so the queue cannot grow one row per delivery for a store that pushes the same excluded order
 * repeatedly.
 */
export async function recordWcOrderAdmissionRefusal(
  wcOrder: Pick<WcFullOrder, 'id' | 'number' | 'status'> & Partial<Pick<WcFullOrder, 'currency'>>,
  reason: WcAdmissionRefusalReason,
  configured: string[],
): Promise<WcAdmissionRefusalRecord> {
  try {
    const externalOrderId = String(wcOrder.id)
    const existing = await db.shoppingSyncLog.findFirst({
      where: wcAdmissionRefusalQueueWhere(externalOrderId),
      orderBy: { createdAt: 'desc' },
      select: { id: true, payload: true },
    })
    const previous = isWcAdmissionRefusalPayload(existing?.payload) ? existing.payload : null
    // Not `|| ''`: an absent field and a blank one are the SAME refusal but not the same message,
    // and this is the one record that can still tell them apart.
    const statedCurrency = typeof wcOrder.currency === 'string' ? wcOrder.currency : ''
    const payload: WcAdmissionRefusalPayload = {
      queue: WC_ADMISSION_REFUSAL_QUEUE,
      reason,
      connector: 'woocommerce',
      externalOrderId,
      externalOrderNumber: String(wcOrder.number ?? ''),
      status: String(wcOrder.status ?? ''),
      configured,
      currency: statedCurrency,
      refusedAt: previous?.refusedAt ?? new Date().toISOString(),
      attempts: previous?.attempts ?? 0,
    }
    const data = {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR' as const,
      status: 'PENDING' as const,
      entityType: 'SalesOrder',
      externalId: externalOrderId,
      payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
      errorMessage: refusalDescription(reason, payload.status, configured, statedCurrency),
      syncedAt: null,
    }
    if (existing) await db.shoppingSyncLog.update({ where: { id: existing.id }, data })
    else await db.shoppingSyncLog.create({ data })

    // READ IT BACK THROUGH THE DRAIN'S OWN `where`. Not paranoia about Prisma: the write above
    // takes two different shapes (update an existing row, or create one), and only this query
    // decides whether the fifteen-minute sweep will ever see the result of either.
    const confirmed = await db.shoppingSyncLog.findFirst({
      where: wcAdmissionRefusalQueueWhere(externalOrderId),
      select: { id: true },
    })
    if (!confirmed) {
      console.error(
        `o3d-batch-ret r14: an admission refusal for WooCommerce order ${externalOrderId} wrote no row the by-id drain can read`,
      )
      return { persisted: false, reason: 'the refusal queue row could not be read back after writing' }
    }
    return { persisted: true, id: confirmed.id }
  } catch (e) {
    console.error('o3d-tj6v r5: failed to record an admission refusal for later retry', e)
    return { persisted: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export type WcAdmissionRefusalDrainResult = {
  scanned: number
  imported: number
  stillRefused: number
  unresolved: number
  retired: number
}

/** The live order, or null when it cannot be read. */
async function readLiveWcOrder(externalOrderId: string): Promise<WcFullOrder | null> {
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
    if (error || !data || typeof data !== 'object' || !('status' in data)) return null
    return data as WcFullOrder
  } catch {
    return null
  }
}

async function resolveRefusalRow(id: string, outcome: string, orderId?: string): Promise<void> {
  await db.shoppingSyncLog.update({
    where: { id },
    data: { status: 'SYNCED', entityId: orderId ?? null, errorMessage: outcome, syncedAt: new Date() },
  })
}

/**
 * Re-check every order the admission boundary turned away, BY ID.
 *
 * By id is the whole point: the refusal was acknowledged, so WooCommerce will never push it again,
 * and it sits behind the pull cursors — a `?modified_after=` sweep cannot reach it and a
 * `?status=` query would not return it while the status is still excluded. This route depends on
 * neither.
 *
 * The order is put back through the ORDINARY gated importer rather than being judged here, so
 * there is still exactly one admission decision in the system. That is also what repairs a refusal
 * that lost a race to a concurrent create: `importWcOrder` finds the order IMS now holds and takes
 * the UPDATE branch, which is never gated.
 */
export async function drainWcOrderAdmissionRefusals(limit = 50): Promise<WcAdmissionRefusalDrainResult> {
  const rows = await db.shoppingSyncLog.findMany({
    where: wcAdmissionRefusalQueueWhere(),
    // Oldest-ATTEMPTED first. Every outcome below re-stamps `createdAt`, so the queue rotates and
    // an order that cannot be read — a deleted order, a broken credential — cannot pin the head of
    // a fixed prefix and starve every refusal behind it (the failure Codex r12 found in the
    // withdrawal sweep, which solves it the same way with `lastCheckedAt`).
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 250),
    select: { id: true, payload: true, externalId: true },
  })

  const result: WcAdmissionRefusalDrainResult = {
    scanned: rows.length, imported: 0, stillRefused: 0, unresolved: 0, retired: 0,
  }
  if (rows.length === 0) return result

  const { importWcOrder } = await import('./order-import')
  const { importWcOrderGuarded } = await import('./withdrawal')

  for (const row of rows) {
    const payload = isWcAdmissionRefusalPayload(row.payload) ? row.payload : null
    const externalOrderId = payload?.externalOrderId ?? row.externalId
    if (!externalOrderId) {
      await resolveRefusalRow(row.id, 'Admission refusal row carries no WooCommerce order id')
      result.retired++
      continue
    }

    // Rotate BEFORE the work, so a row that throws still moves to the back of the queue.
    await db.shoppingSyncLog.update({
      where: { id: row.id },
      data: {
        createdAt: new Date(),
        ...(payload
          ? { payload: JSON.parse(JSON.stringify({ ...payload, attempts: payload.attempts + 1 })) as Prisma.InputJsonValue }
          : {}),
      },
    }).catch(() => {})

    const live = await readLiveWcOrder(externalOrderId)
    if (!live) {
      result.unresolved++
      continue
    }

    try {
      const guarded = await importWcOrderGuarded(live, () => importWcOrder(live))
      if (guarded.outcome === 'skipped-withdrawal') {
        // The customer withdrew it. The withdrawal tombstone is now this order's durable signal
        // and it re-imports through the same gated importer, so keeping a second queue row for the
        // same order would only re-read the same order twice every sweep.
        await resolveRefusalRow(row.id, 'The customer withdrew this order; the withdrawal sweep now owns it')
        result.retired++
        continue
      }
      if (guarded.outcome === 'unresolved') {
        result.unresolved++
        continue
      }
      if (guarded.result.skipped) {
        // Still refused, for whatever reason applies NOW — the row's payload was refreshed by the
        // refusal recorded inside importWcOrder, so a status that moved from excluded to unmapped
        // is described accurately without this drain having its own opinion about either.
        result.stillRefused++
        continue
      }
      if (guarded.result.success && guarded.result.orderId) {
        await resolveRefusalRow(
          row.id,
          `Imported by the admission-refusal retry once the order became admissible (status "${String(live.status)}")`,
          guarded.result.orderId,
        )
        result.imported++
        continue
      }
      result.unresolved++
    } catch (e) {
      result.unresolved++
      console.error(`[wc-admission-refusal-drain] ${externalOrderId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (result.imported > 0 || result.retired > 0) {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_order_admission_refusal_drained',
      tag: 'sync',
      level: 'INFO',
      description: `Re-checked ${result.scanned} WooCommerce order(s) the "Import order statuses" boundary had `
        + `turned away: ${result.imported} imported, ${result.stillRefused} still excluded, `
        + `${result.retired} retired, ${result.unresolved} could not be read.`,
      metadata: { ...result },
      resolveUser: false,
    })
  }

  return result
}
