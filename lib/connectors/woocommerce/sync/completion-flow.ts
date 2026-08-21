/**
 * WC "completed" → IMS shipment workflow.
 *
 * WooCommerce is treated as the dispatch authority for external storefront
 * orders. When an order is marked completed in Woo, the IMS auto-allocates,
 * creates shipment rows, and advances those shipments to SHIPPED with tracking.
 */

import type { WcFullOrder } from './types'
import { extractWcTracking } from './field-mapping'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'
import {
  EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE,
  buildExternalFulfillmentRefusalWhere,
  isPermanentExternalFulfillmentRefusal,
} from '@/lib/fulfillment/external-fulfillment-refusal'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'

/** Already dispatched: a completion here is real fulfilment evidence catching
 *  up, not something a withdrawal should block. */
const POST_DISPATCH_FOR_WDRAW: ReadonlySet<string> = new Set(['SHIPPED', 'COMPLETED', 'DELIVERED'])

/**
 * o3d-xnwu. `permanent: true` means a stable business rule refused the
 * completion, so re-delivering the identical webhook re-hits the identical rule:
 * the caller acknowledges it and the refusal is carried by the exception inbox
 * row written below, not by a retry ladder that ends in a dead letter nobody
 * connected to this order.
 */
export type WcCompletionResult = { success: boolean; error?: string; permanent?: boolean }

/**
 * Was the admin bell for this refusal actually delivered?
 *
 * o3d-xnwu round 3, Codex finding 4. `notify` SWALLOWS its errors — that is its
 * documented job — so a failed bell used to be indistinguishable from a
 * delivered one. The dedupe then made it permanent: the exception row existed
 * (its transaction had already committed), so every later refusal of the same
 * order took the "already told them" branch and nobody was ever told. A
 * notification that failed was treated as delivered, forever, and nothing said
 * so anywhere.
 *
 * Delivery is therefore recorded ON the row, not inferred from the row's
 * existence. `adminNotified` answers "is there anything left to ring?" and has
 * THREE states, not two (o3d-xnwu round 5, finding 3):
 *
 *   false          still ringing — this is what the sweep selects on;
 *   true           every active admin has a notification row;
 *   'exhausted'    the sweep gave up after WC_REFUSAL_BELL_ATTEMPT_LIMIT tries.
 *
 * Only `true` means delivered. An exhausted row is NOT delivered, so a fresh
 * refusal of the same order rings again — it is merely no longer retried on a
 * timer, which is what stops one undeliverable row alerting for ever.
 */
function wasAdminBellDelivered(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  return (payload as { adminNotified?: unknown }).adminNotified === true
}

/** How many undelivered bells one sweep will attempt. */
export const WC_REFUSAL_BELL_RETRY_LIMIT = 50

/**
 * How many times one refusal's bell is attempted before the sweep stops
 * attempting it (o3d-xnwu round 5, finding 3).
 *
 * WHY THERE HAS TO BE A BOUND. Round 4 gave the bell a driver — a job every
 * fifteen minutes that re-rings anything not marked delivered — and no way to
 * ever stop. A row that CANNOT be delivered (an install with no active ADMIN
 * user, an admin whose notification insert fails on a constraint, a payload the
 * notifier rejects) therefore did two harmful things for ever: it occupied a
 * place in the oldest-first window, so a refusal filed later waited behind it,
 * and it made the cron run red every quarter of an hour, which is how an alert
 * that means something becomes an alert everybody filters.
 *
 * Twelve attempts at a quarter-hour cadence is three hours of trying. After
 * that the row is marked `'exhausted'` and drops out of the sweep's selection
 * entirely — that is the escape, and it is why a poison row can delay a later
 * one by three hours rather than indefinitely.
 *
 * NOTHING IS ABANDONED BY IT. The exception row stays QUARANTINED and on
 * /sync/exceptions, where it was always the primary record; one ERROR activity
 * row is written at the moment of giving up, naming the order; and the next
 * refusal of that order re-files the row with a fresh budget. What stops is the
 * ringing, not the record.
 */
export const WC_REFUSAL_BELL_ATTEMPT_LIMIT = 12

type WcRefusalBellRow = {
  id: string
  entityId: string | null
  externalId: string | null
  errorMessage: string | null
  payload: unknown
}

function refusalPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : {}
}

/**
 * The admins this row has ALREADY got a notification row for.
 *
 * o3d-xnwu round 5, finding 3 — the other half of "spam reachable admins".
 * Delivery used to be all-or-nothing: two admins, one unreachable, and every
 * single attempt re-notified the one who could be reached. With a driver
 * running every fifteen minutes that is four duplicate bells an hour about one
 * order, aimed at exactly the person who is already looking at it. Remembering
 * WHO was told makes the retry target only the admin who was not.
 */
function bellDeliveredTo(payload: Record<string, unknown>): Set<string> {
  const raw = payload.adminBellDeliveredTo
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((entry): entry is string => typeof entry === 'string'))
}

function bellAttempts(payload: Record<string, unknown>): number {
  const raw = payload.adminBellAttempts
  const attempts = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(attempts) && attempts > 0 ? attempts : 0
}

export type WcRefusalBellOutcome = {
  /** Every active admin now has a notification row for this refusal. */
  complete: boolean
  /**
   * The attempt budget ran out on this attempt AND the row now records that we
   * gave up, so the sweep will not select it again.
   *
   * o3d-xnwu round 6, finding 1. This is deliberately the WRITTEN state and not
   * the decision: round 5 made exhaustion a third state precisely so a row could
   * leave the queue while still saying plainly that nobody was told, and a
   * giving-up that no row records says nothing to anybody. Reporting it anyway
   * would make the loudness and the durability disagree — the operator would be
   * told, once and loudly, about a state the table does not contain, and the row
   * would go on being retried underneath that report.
   *
   * The write can fail to land in two ways, and both mean the same thing here:
   * the update threw, or its fence matched nothing because the row was resolved
   * or replaced by a fresh refusal mid-ring. In either case the row still says
   * `false` — either this one or the fresh one — so the sweep will select it
   * again, which is the same direction round 5 chose for the delivery write: a
   * record that fails to write leaves the old marker standing, so failure is
   * always towards asking again.
   */
  exhausted: boolean
  /** Active ADMIN users at the moment of the attempt. */
  admins: number
  /** How many of them have been told, cumulatively across attempts. */
  delivered: number
}

/**
 * Ring the admins about ONE open refusal, and record on the row who was actually
 * told, how many times we have tried, and whether we have stopped trying.
 *
 * The single place the bell is rung, so the first attempt at the moment of
 * refusal and the sweep's later re-attempt cannot drift into saying different
 * things about the same order, or into counting delivery differently.
 */
async function ringWcCompletionRefusalBell(row: WcRefusalBellRow): Promise<WcRefusalBellOutcome> {
  const payload = refusalPayload(row.payload)
  const orderNumber = typeof payload.wcOrderNumber === 'string' && payload.wcOrderNumber
    ? payload.wcOrderNumber
    : (row.externalId ?? row.entityId ?? 'unknown')

  const admins = await db.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
  const deliveredTo = bellDeliveredTo(payload)
  // Only the admins who have no row yet. An admin already told about THIS
  // refusal is not told again, however many times the sweep comes round.
  const pending = admins.filter((admin) => !deliveredTo.has(admin.id))
  // allSettled, not all: one admin's failed insert must not discard the others'
  // successes, and a rejection here must not throw out of a function whose
  // caller reads a throw as "the exception row could not be filed".
  const results = await Promise.allSettled(pending.map((admin) => notify({
    userId: admin.id,
    type: 'error',
    title: 'WooCommerce order completed but not fulfilled',
    message:
      `WooCommerce marked order ${orderNumber} as completed, but IMS refused to record the dispatch: `
      + `${row.errorMessage ?? 'External fulfillment update failed'}. No shipment exists and no stock has moved.`
      + ' It needs attention in the sync exception inbox.',
    actionUrl: '/sync/exceptions',
  })))

  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value === true) deliveredTo.add(pending[index].id)
  })

  const attempts = bellAttempts(payload) + 1
  // An empty admin list is a FAILED bell, not a satisfied one: `Promise.all([])`
  // resolving is not the same as somebody having been told, and an install with
  // no active admin is exactly where an unfulfilled order goes unnoticed.
  // Counted against the admins who exist NOW, not against the size of the
  // remembered set: a set that still names somebody who has since been
  // deactivated would report "3 of 2 notification(s) were written", and a tally
  // that cannot be true is a tally nobody reads twice. The set itself keeps them,
  // because it is a record of who was told and not a list of who to tell.
  const delivered = admins.filter((admin) => deliveredTo.has(admin.id)).length
  const complete = admins.length > 0 && delivered === admins.length
  // The DECISION to give up. Whether we may REPORT it depends on the write
  // below landing — see `WcRefusalBellOutcome.exhausted`.
  const givingUp = !complete && attempts >= WC_REFUSAL_BELL_ATTEMPT_LIMIT

  // Written on EVERY attempt, not only on full success (o3d-xnwu round 5). The
  // partial progress is the whole point: losing it means the admin who WAS
  // reached gets rung again next time, which is the spam this replaces.
  //
  // FENCED on the refusal predicate as well as the id, because between the read
  // and this write the row can have been replaced by a fresh refusal of the same
  // order (delete-and-recreate, so a NEW id) or resolved and deleted outright.
  // `updateMany` matching nothing is the correct outcome there, and `update` by
  // id alone would either throw or stamp a row whose delivery state we never
  // actually established.
  const recorded = await db.shoppingSyncLog.updateMany({
    where: { id: row.id, ...buildExternalFulfillmentRefusalWhere(row.entityId ?? undefined) },
    data: {
      payload: JSON.parse(JSON.stringify({
        ...payload,
        adminNotified: complete ? true : (givingUp ? 'exhausted' : false),
        adminBellDeliveredTo: [...deliveredTo],
        adminBellAttempts: attempts,
      })),
    },
  // The bell WAS rung; failing to write that down must not undo it. The cost
  // of losing this write is one duplicate bell next time, which is the right
  // direction to err.
  //
  // `count === 1` and not `catch`-only: the fence carries an id, so the update
  // matches one row or none, and NONE is not an error — it is the row having
  // been resolved or replaced while we rang. Both readings of "it did not land"
  // have to reach the caller, because what the caller may report about giving up
  // is exactly what this write put in the table.
  }).then((result) => result.count === 1).catch(() => false)

  return { complete, exhausted: givingUp && recorded, admins: admins.length, delivered }
}

/**
 * RETRY THE BELLS NOBODY EVER HEARD (o3d-xnwu round 4, finding 2).
 *
 * Round 3 stopped a failed bell being recorded as delivered, and re-rang it on
 * the NEXT refusal of the same order. That is a retry with no driver of its own:
 * the trigger for it is another webhook or another poll deciding to refuse the
 * same order again — and the commonest refusal, an order that cannot be
 * fulfilled from stock, is acknowledged precisely so it is NOT re-delivered. So
 * the one case where nobody was told is also the case least likely to happen a
 * second time. An outage in the notification write during the only refusal an
 * order ever gets left it silently unannounced for ever, exactly as before, and
 * the only surviving trace was an activity row among thousands.
 *
 * This sweep is the driver. It is deliberately NOT gated on the WooCommerce sync
 * or plugin switches: it calls no external system and imports nothing, it reads
 * local rows and writes local notifications, and an operator pausing the sync is
 * not an operator saying they no longer want to hear about the orders it already
 * refused.
 *
 * IT IS BOUNDED IN TWO DIRECTIONS (o3d-xnwu round 5, finding 3). Per run, by the
 * take below. Per ROW, by WC_REFUSAL_BELL_ATTEMPT_LIMIT: a row that cannot be
 * delivered leaves the selection after three hours of trying, which is what
 * stops it holding the front of an oldest-first window against every refusal
 * filed after it, and what stops it re-alerting for ever.
 */
export async function retryUnnotifiedWcCompletionRefusalBells(
  opts: { limit?: number } = {},
): Promise<{
  scanned: number
  delivered: number
  stillUndelivered: number
  exhausted: number
  adminCount: number
}> {
  const rows = await db.shoppingSyncLog.findMany({
    where: {
      ...buildExternalFulfillmentRefusalWhere(),
      // An EXPLICIT `false`, not "anything that is not true".
      //
      // A JSON path predicate over an ABSENT key is SQL NULL, so `NOT (... =
      // true)` is NULL and the row is filtered out — the negated form would
      // silently match nothing but the rows it was written to exclude. Every row
      // this module files carries the key, because it is written on creation,
      // true or false.
      //
      // It is also how a row LEAVES the sweep for good without being told a lie
      // about: giving up writes `'exhausted'` into this same key, which is not
      // `false`, so the row drops out here while still saying plainly that
      // nobody was ever told.
      //
      // Rows filed BEFORE this branch have no key and are therefore not swept.
      // That is deliberate: they were belled once under the old code, and
      // re-ringing every historical refusal on deploy is a notification storm
      // that would teach an operator to ignore precisely this bell. A fresh
      // refusal of such an order re-files the row WITH the key.
      payload: { path: ['adminNotified'], equals: false },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? WC_REFUSAL_BELL_RETRY_LIMIT,
    select: { id: true, entityId: true, externalId: true, errorMessage: true, payload: true },
  })

  let delivered = 0
  let exhausted = 0
  let adminCount = 0
  for (const row of rows) {
    const outcome = await ringWcCompletionRefusalBell(row)
    adminCount = outcome.admins
    if (outcome.complete) delivered++
    if (outcome.exhausted) {
      exhausted++
      // The one loud line per row, at the moment the retrying stops. Not one per
      // sweep: an ERROR every fifteen minutes about the same order is how a real
      // signal gets filtered into a mail rule, which is the defect this finding
      // is about.
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: row.entityId ?? undefined,
        action: 'wc_completion_refusal_bell_exhausted',
        tag: 'sync',
        level: 'ERROR',
        description:
          `Gave up ringing the admins about a refused WooCommerce completion of order ${row.entityId ?? 'unknown'}`
          + ` after ${WC_REFUSAL_BELL_ATTEMPT_LIMIT} attempts:`
          + ` ${outcome.delivered} of ${outcome.admins} notification(s) exist`
          + `${outcome.admins === 0 ? ' — there is no active ADMIN user to notify' : ''}.`
          + ' The refusal itself is NOT resolved: it is still QUARANTINED on /sync/exceptions, and the next refusal of'
          + ' this order rings again with a fresh budget. What has stopped is the retry, so one undeliverable bell no'
          + ' longer delays the refusals filed after it or re-alerts every quarter of an hour.'
          + ` The refusal was: ${row.errorMessage ?? 'External fulfillment update failed'}`,
        metadata: {
          externalOrderId: row.externalId,
          adminCount: outcome.admins,
          notificationsDelivered: outcome.delivered,
          attempts: WC_REFUSAL_BELL_ATTEMPT_LIMIT,
        },
        resolveUser: false,
      }).catch(() => {})
    }
  }

  // No per-row activity row on an ordinary retry. The first failure already wrote
  // one, and one ERROR per unnotified order every fifteen minutes is how a real
  // signal gets filtered into a mail rule. The cron run itself carries the state.
  return {
    scanned: rows.length,
    delivered,
    stillUndelivered: rows.length - delivered - exhausted,
    exhausted,
    adminCount,
  }
}

/**
 * ONE open row per order, decided AFTER every racing create is visible.
 *
 * o3d-xnwu round 6, finding 2. `recordWcCompletionRefusal` deletes the open row
 * and creates a replacement, and there is nothing for those two statements to
 * contend on: with no open row to lock, two concurrent refusals of the same
 * order — the webhook and the daily reconcile arriving together — each delete
 * NOTHING and each create a row. The result defeats both invariants at once. Two
 * QUARANTINED rows for one order is the pile the dedupe exists to prevent, and
 * each row carries its own delivery set, so each runs its own bell ladder: the
 * same admin is rung twice at the refusal and twice more every fifteen minutes
 * for three hours.
 *
 * WHY THIS IS NOT A LOCK. A per-order lock over the delete-and-create would
 * guarantee the one row, and would still ring twice: the racers would file one
 * after the other, and the SECOND one reads the first row's delivery set BEFORE
 * the first has finished notifying, so it carries an empty set forward and rings
 * everybody again. The window that has to be covered is the create AND the
 * ringing, and a lock held across the notification writes is a transaction held
 * open while another connection writes — trading a rare duplicate bell for a
 * pool hazard on every refusal. (o3d-tj6v reached the same conclusion from the
 * other side: a lock across a pivot that does not span the whole window covers
 * none of it, and it closed its race by making the refusal non-terminal and
 * re-driving it instead.)
 *
 * So arbitrate LATE rather than early. Every racer re-reads the open rows after
 * its own create has landed, and they all pick the same survivor. That is
 * strictly better than a lock for the bell: in the case where both creates land
 * before either rings — the common one, because notifying is the slow part —
 * only the racer that owns the survivor rings at all, so there is exactly one
 * bell where a lock would have produced two.
 *
 * THE SURVIVOR IS CHOSEN BY ID, not by a timestamp. Any total order every racer
 * agrees on will do, and the ids are one; `createdAt` is not, because whether it
 * is stamped by the database or by the client is not something this module can
 * see, and two hosts' clocks deciding which refusal is "later" is the failure
 * mode this branch has spent five rounds removing. The rows are milliseconds
 * apart, so WHICH one survives is immaterial — that every racer picks the SAME
 * one is the whole content of the rule.
 *
 * Nothing is dropped by the merge. The losers' delivered sets are unioned into
 * the survivor FIRST, and the losers are deleted only if that union actually
 * landed: a merge that failed to write leaves the duplicates standing, because
 * two visible rows for one order is a tidiness defect and a deleted last row is
 * a refusal nobody can see.
 *
 * Returns the surviving row when it is the caller's OWN create — the caller
 * rings it — and `null` otherwise. `null` is not a dropped bell: the surviving
 * row still says `adminNotified: false`, so the fifteen-minute sweep re-drives
 * it by id even if the racer that owns it dies between its create and its ring.
 */
async function convergeOpenWcCompletionRefusals(
  orderId: string,
  createdId: string,
): Promise<{ id: string; payload: unknown } | null> {
  const rows = await db.shoppingSyncLog.findMany({
    where: buildExternalFulfillmentRefusalWhere(orderId),
    orderBy: { id: 'asc' },
    select: { id: true, payload: true },
  })
  if (rows.length === 0) return null
  const survivor = rows[rows.length - 1]
  const mine = survivor.id === createdId
  // The ordinary path: our create is the only open row. Not ours means a racer
  // replaced it between our create and this read — theirs stands, and theirs rings.
  if (rows.length === 1) return mine ? survivor : null

  const losers = rows.slice(0, -1)
  const merged = refusalPayload(survivor.payload)
  const deliveredTo = bellDeliveredTo(merged)
  // `true` wins over `false`. A racer that read the PREVIOUS row after its bell
  // landed and carried `true` forward is holding the later, truer reading of the
  // same fact; discarding it would re-ring admins already told. Only `true` ever
  // silences a bell, so `'exhausted'` and `false` both leave it ringing.
  let notified = wasAdminBellDelivered(survivor.payload)
  for (const loser of losers) {
    for (const admin of bellDeliveredTo(refusalPayload(loser.payload))) deliveredTo.add(admin)
    if (wasAdminBellDelivered(loser.payload)) notified = true
  }
  merged.adminNotified = notified
  merged.adminBellDeliveredTo = [...deliveredTo]

  const unionWritten = await db.shoppingSyncLog.updateMany({
    where: { id: survivor.id, ...buildExternalFulfillmentRefusalWhere(orderId) },
    data: { payload: JSON.parse(JSON.stringify(merged)) },
  }).then((result) => result.count === 1).catch(() => false)
  // The report follows the write here too. Deleting the losers before knowing
  // the union landed can delete the only record that an admin was already told,
  // and — if the survivor was resolved between the read and the write — the only
  // record of the refusal itself.
  if (!unionWritten) return mine ? survivor : null

  await db.shoppingSyncLog.deleteMany({
    where: { id: { in: losers.map((loser) => loser.id) }, ...buildExternalFulfillmentRefusalWhere(orderId) },
  }).catch(() => {})

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'wc_completion_refusal_deduped',
    tag: 'sync',
    level: 'WARNING',
    description:
      `Two or more refusals of WooCommerce order ${orderId} were filed at once, so ${rows.length} exception rows existed`
      + ' for it. They have been merged into one: the surviving row carries the union of the admins already told, and'
      + ' the duplicates were removed. Nothing about the refusal itself changed, and no bell was lost.',
    metadata: { duplicates: losers.length, survivingRow: survivor.id },
    resolveUser: false,
  }).catch(() => {})

  return mine ? { id: survivor.id, payload: merged } : null
}

/**
 * Park a refusal where an operator is already looking (/sync/exceptions).
 *
 * ONE open row per order: a refusal that recurs (the daily reconcile, another
 * store edit) must not turn one unfulfillable order into a growing pile of
 * identical rows, which is the same dedupe rule the product structure conflicts
 * follow. Deleting and re-creating rather than updating deliberately re-stamps
 * `createdAt`, so the timestamp reads as "last refused", which is what an
 * operator triaging the list needs.
 *
 * The delete-and-create cannot enforce that on its own when two refusals of the
 * same order arrive together — nothing serializes two deletes that both match
 * nothing — so `convergeOpenWcCompletionRefusals` settles it after the fact, and
 * decides which row rings.
 */
async function recordWcCompletionRefusal(orderId: string, wcOrder: WcFullOrder, error: string): Promise<void> {
  // Read the open row BEFORE replacing it, because the one thing that must
  // survive the replacement is whether its bell was ever delivered, and to WHOM.
  // `deleteMany` reports a count and not the rows, and a count cannot answer
  // either question.
  const open = await db.shoppingSyncLog.findFirst({
    where: buildExternalFulfillmentRefusalWhere(orderId),
    select: { payload: true },
  })
  const alreadyBelled = wasAdminBellDelivered(open?.payload)
  // Carried across the re-file, so a recurring refusal — the daily reconcile
  // finding the same unfulfillable order again — does not re-ring the admins who
  // were already told about it (o3d-xnwu round 5, finding 3). The ATTEMPT count
  // is not carried: a fresh refusal is fresh evidence and gets a fresh budget,
  // which is also how an exhausted row starts ringing again.
  const alreadyDeliveredTo = [...bellDeliveredTo(refusalPayload(open?.payload))]

  const [, created] = await db.$transaction([
    db.shoppingSyncLog.deleteMany({ where: buildExternalFulfillmentRefusalWhere(orderId) }),
    db.shoppingSyncLog.create({
      data: {
        connector: 'woocommerce',
        direction: 'FROM_CONNECTOR',
        status: 'QUARANTINED',
        entityType: EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE,
        entityId: orderId,
        externalId: String(wcOrder.id),
        errorMessage: error,
        payload: JSON.parse(JSON.stringify({
          wcStatus: wcOrder.status,
          wcOrderNumber: wcOrder.number ?? null,
          // Carried forward, so a re-refusal of an order whose bell DID land does
          // not ring it again, and one whose bell did not gets another go.
          adminNotified: alreadyBelled,
          adminBellDeliveredTo: alreadyDeliveredTo,
          adminBellAttempts: 0,
        })),
      },
    }),
  ])

  // Bell the admins the FIRST time an order is refused, exactly as the WMS
  // dispatch dead-letter does for the same underlying cause, and pointing at the
  // same page. Once only: a further refusal of an order already on the list adds
  // nothing an operator has not been told, and a bell per redelivery would train
  // them to ignore it.
  //
  // "Once" now means once DELIVERED rather than once attempted.
  //
  // Individually, never broadcast (userId null): the message names a customer
  // order, which READONLY/SUPPLIER users must not be shown.
  //
  // Rung against the SURVIVING row rather than blindly against the one we just
  // created (o3d-xnwu round 6, finding 2). Two refusals filed at once leave two
  // rows and, unresolved, two independent bell ladders aimed at the same admins;
  // only the racer whose create survived rings, and it rings from the merged
  // delivery set, so an admin another racer already told is not told again.
  const surviving = await convergeOpenWcCompletionRefusals(orderId, created.id)
  // Somebody else's row stands, or the refusal was resolved while we were
  // filing. Either way this is not the row that rings, and the one that does is
  // reachable without us: it says `adminNotified: false` and the sweep drives it.
  if (!surviving) return
  // Read from the SURVIVOR, not from the pre-transaction read: the merge may
  // have carried a delivery the racer recorded after we took ours.
  if (wasAdminBellDelivered(surviving.payload)) return

  const { complete, delivered, admins } = await ringWcCompletionRefusalBell({
    id: surviving.id,
    entityId: orderId,
    externalId: String(wcOrder.id),
    errorMessage: error,
    payload: surviving.payload,
  })
  if (complete) return

  // Reported once, at the moment it fails. The RETRY is not this row's job any
  // more: `retryUnnotifiedWcCompletionRefusalBells` sweeps the unnotified rows on
  // its own schedule (o3d-xnwu round 4, finding 2), so the bell no longer waits
  // for the same order to be refused a second time — which, for the acknowledged
  // stock refusal that produces most of these, may never happen at all.
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: 'wc_completion_refusal_unnotified',
    tag: 'sync',
    level: 'ERROR',
    description:
      `Filed the exception row for a refused WooCommerce completion of order ${orderId}, but could not tell the admins:`
      + ` ${delivered} of ${admins} notification(s) were written`
      + `${admins === 0 ? ' — there is no active ADMIN user to notify' : ''}.`
      + ' The refusal is on /sync/exceptions and the bell is retried by the wc-refusal-bell-retry job until it lands,'
      + ` or until ${WC_REFUSAL_BELL_ATTEMPT_LIMIT} attempts have failed, which is reported separately.`
      + ` The refusal itself was: ${error}`,
    metadata: {
      externalOrderId: wcOrder.id,
      adminCount: admins,
      notificationsDelivered: delivered,
    },
    resolveUser: false,
  }).catch(() => {})
}

/** A completion that succeeded answers the open refusal — the row is a live state, not a log. */
async function clearWcCompletionRefusal(orderId: string): Promise<void> {
  await db.shoppingSyncLog.deleteMany({ where: buildExternalFulfillmentRefusalWhere(orderId) })
}

export async function processWcCompletion(orderId: string, wcOrder: WcFullOrder): Promise<WcCompletionResult> {
  // o3d-e1yb [wdraw]: this path bypasses applySalesOrderStatusTransition
  // entirely, so the locked terminal-approval guard there does NOT cover it.
  // A completion worker can read the order before an approval commits, pause,
  // and then allocate, create shipments and consume stock for an order the
  // customer has withdrawn — after which the approval retry sees dispatch
  // evidence and permanently refuses the cancellation, silently converting an
  // approved withdrawal into a return.
  //
  // Re-read under the same row lock the withdrawal handler takes, so the two
  // are mutually exclusive rather than merely racing.
  const approved = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM sales_orders WHERE id = ${orderId} FOR UPDATE`
    if (locked.length === 0) return null
    const so = await tx.salesOrder.findUnique({
      where: { id: orderId },
      select: { withdrawalApprovedAt: true, status: true },
    })
    return so ?? null
  })
  if (approved?.withdrawalApprovedAt && !POST_DISPATCH_FOR_WDRAW.has(approved.status)) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'wc_completion_refused_withdrawn',
      tag: 'sync',
      level: 'WARNING',
      description:
        'Refused a WooCommerce completion for an order whose EU withdrawal request was approved. '
        + 'Fulfilling it would have allocated stock and created shipments for goods the customer '
        + 'asked to withdraw.',
      metadata: { externalOrderId: wcOrder.id, wcStatus: wcOrder.status, imsStatus: approved.status },
      resolveUser: false,
    })
    // Reported as a SUCCESSFUL outcome deliberately: this refusal is the
    // intended end state (the customer withdrew; nothing should ship), it
    // already writes its own WARNING row naming the order, and there is nothing
    // for an operator to unblock. Everything below is the opposite case — an
    // order that SHOULD have shipped and did not.
    return { success: true }
  }

  const wcTracking = extractWcTracking(wcOrder)

  const applied = await applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId },
    targetShipmentStatus: 'SHIPPED',
    tracking: wcTracking.map((row) => ({
      trackingNumber: row.trackingNumber,
      shippingService: row.carrier,
    })),
  })

  // o3d-xnwu: this result used to be DISCARDED. The store showed the order as
  // completed, IMS never created the shipment, and nobody — not the caller, not
  // the webhook, not an operator — was told.
  if (!applied.success) {
    const error = applied.error ?? 'External fulfillment update failed'
    const permanent = isPermanentExternalFulfillmentRefusal(applied.reason)
    let filed = true
    if (permanent) {
      // A retry cannot clear this one, so it goes where it can be seen and acted
      // on.
      try {
        await recordWcCompletionRefusal(orderId, wcOrder, error)
      } catch (recordError) {
        filed = false
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: orderId,
          action: 'wc_completion_refusal_unrecorded',
          tag: 'sync',
          level: 'ERROR',
          description:
            `Could not file the exception row for a refused WooCommerce completion of order ${orderId}: `
            + `${recordError instanceof Error ? recordError.message : String(recordError)}. The refusal itself was: ${error}`,
          metadata: { externalOrderId: wcOrder.id },
          resolveUser: false,
        }).catch(() => {})
      }
    }
    // Acknowledging a permanent refusal is only safe BECAUSE it has been filed
    // somewhere an operator will find it. If that write failed, do not close the
    // delivery over it — the failed write is itself retryable, and a refusal
    // nobody can see is not a refusal.
    return { success: false, error, permanent: permanent && filed }
  }

  await clearWcCompletionRefusal(orderId)
  return { success: true }
}
