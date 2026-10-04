/**
 * MAY IMS COMPLETE THIS WOOCOMMERCE ORDER? (o3d-zvec.15, o3d-zvec.4 check 1)
 *
 * Pushing `completed` is a PROMOTION: it fires WooCommerce's completed-order machinery (customer
 * email, downloads). It is right only for an order the storefront still holds as in flight, and wrong
 * for one an operator has cancelled, refunded, held or finalised by hand — promoting those would
 * resurrect them.
 *
 * "In flight" is NOT a list of WooCommerce slugs kept here. It is the importer's own reading of the
 * status (`readWcOrderStatus`: the mapping table, else the built-in defaults) plus the order state
 * machine, so the completion rule and the importer cannot drift apart: a custom `ready-to-ship` mapped
 * to PROCESSING, or a `packed` mapped to PACKING, completes exactly because the importer treats it as
 * in flight. One literal remains — our own plugin's `partial-shipped` — see partial-shipment.ts.
 *
 * Pure: the caller supplies the reading and the withdrawal statuses, so this decides nothing from I/O.
 */
import { canTransitionSalesOrder } from '@/lib/domain/workflows/sales-order-state'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
import type { WcOrderStatusReading } from './status-mapping'
import { WC_PARTIAL_SHIPPED_STATUS } from './partial-shipment'

export type WcCompletionEligibility =
  | 'eligible'
  | 'already-at-target'
  | 'ineligible-finalised'
  | 'ineligible-not-ready'
  | 'ineligible-unknown'

const FINALISED_IMS_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'COMPLETED', 'DELIVERED'])
/**
 * WooCommerce's OWN statuses that can never be in flight, refused BEFORE the configurable mapping is read. The
 * status-mapping action accepts any slug and maps it to any IMS status, so a row sending `cancelled` or
 * `on-hold` to PROCESSING would otherwise make this rule complete an order the operator cancelled or held.
 * (`completed` and `refunded` are already caught by `handledBy`.)
 */
const CANONICAL_CANCELLED_SLUGS: ReadonlySet<string> = new Set(['cancelled'])
const CANONICAL_NOT_READY_SLUGS: ReadonlySet<string> = new Set(['on-hold', 'pending', 'failed'])
const NOT_READY_IMS_STATUSES: ReadonlySet<string> = new Set(['ON_HOLD', 'PENDING_PAYMENT', 'DRAFT'])

export function classifyWcCompletionEligibility(input: {
  reading: Pick<WcOrderStatusReading, 'slug' | 'imsStatus' | 'handledBy'>
  withdrawal: { submitted: string; approved: string }
  /** The WooCommerce slug being pushed. A parameter so a configurable target (o3d-zvec.4 check 3) fits later. */
  target?: string
}): WcCompletionEligibility {
  const { reading, withdrawal } = input
  const target = input.target ?? 'completed'
  const slug = reading.slug

  if (slug === target) return 'already-at-target'
  // `handledBy` carries completed and refunded. Refunded MUST be excluded here and not by its reading:
  // the built-in map reads `refunded` as PROCESSING (the refund state is orthogonal to the lifecycle).
  if (reading.handledBy !== null) return 'ineligible-finalised'
  if (CANONICAL_CANCELLED_SLUGS.has(slug)) return 'ineligible-finalised'
  if (CANONICAL_NOT_READY_SLUGS.has(slug)) return 'ineligible-not-ready'
  // `processing` is WooCommerce's own in-flight status. A mapping row sending it to CANCELLED / ON_HOLD / DELIVERED
  // is evidence about the IMS order, not about what WooCommerce holds, so it must not make a processing order read as
  // settled (which would let the completion job SUCCEED having completed nothing) or as not ready (o3d-6ldlj sweep).
  if (slug === 'processing') return 'eligible'
  if (reading.imsStatus !== null && FINALISED_IMS_STATUSES.has(reading.imsStatus)) return 'ineligible-finalised'
  // Withdrawal statuses deliberately have no mapping row, but an operator may have added one; the
  // withdrawal settings win either way, so check them BEFORE the mapping.
  if (slug === withdrawal.submitted || slug === withdrawal.approved) return 'ineligible-not-ready'
  if (reading.imsStatus !== null && NOT_READY_IMS_STATUSES.has(reading.imsStatus)) return 'ineligible-not-ready'
  if (slug === WC_PARTIAL_SHIPPED_STATUS) return 'eligible'
  if (reading.imsStatus === null) return 'ineligible-unknown'
  if (reading.imsStatus === 'PROCESSING' || canTransitionSalesOrder(reading.imsStatus, 'SHIPPED')) return 'eligible'
  return 'ineligible-unknown'
}

/** The classifier over the live reading: the importer's own mapping lookup plus the withdrawal settings. */
export async function readWcCompletionEligibility(
  wcStatus: unknown,
  target?: string,
): Promise<{ eligibility: WcCompletionEligibility; slug: string }> {
  const [{ readWcOrderStatus }, { getWithdrawalStatuses }] = await Promise.all([
    import('./status-mapping'),
    import('./withdrawal'),
  ])
  const reading = await readWcOrderStatus(wcStatus)
  const withdrawal = await getWithdrawalStatuses()
  return { eligibility: classifyWcCompletionEligibility({ reading, withdrawal, target }), slug: reading.slug }
}

// ---------------------------------------------------------------------------
// CANCEL / HOLD (o3d-6ldlj)
// ---------------------------------------------------------------------------

/**
 * MAY IMS PUSH `cancelled` / `on-hold` ONTO THIS WOOCOMMERCE ORDER?
 *
 * The completion rule above asks "is the order still in flight?". A cancel or hold is the opposite kind of
 * write — it is a DEMOTION that IMS already decided — so the question is "has the storefront moved this order
 * somewhere IMS must not overwrite?":
 *
 *  - `completed` / `refunded` (`handledBy`) are never overwritten, for every target. An IMS cancel PUT over a
 *    completed order would fire WooCommerce's cancel handling (including its own restock; the store's
 *    configuration is UNVERIFIED). They are left alone, with a WARNING, and are NOT an exception.
 *  - For an on-hold push, WooCommerce's own `cancelled` is finalised too (a hold must not resurrect a
 *    cancelled order's email machinery).
 *  - `partial-shipped` (our own plugin's status for a split order that has part shipped) and the EU-withdrawal
 *    statuses are NEVER pushed over automatically: someone has to decide what a cancel of a part-shipped or
 *    withdrawn order means in the storefront. `ineligible-needs-operator`.
 *  - Otherwise the importer's own reading decides, through the order state machine, so a custom in-flight
 *    status mapped to PROCESSING/ALLOCATED/PICKING/PACKING can be cancelled or held exactly because the importer
 *    treats it as in flight. A status IMS has no reading of is `ineligible-unknown` (retried: add a mapping).
 *
 * `already-at-target` is only ever the REAL target slug (a custom status mapped to the target state needs an
 * operator, never a silent success). WooCommerce's OWN slugs are decided BEFORE the configurable mapping is read (the #719 lesson: the
 * status-mapping action accepts any slug and maps it to any IMS status, so a row sending `cancelled` to
 * PROCESSING would otherwise make an on-hold push eligible over a cancelled order).
 *
 * Pure: the caller supplies the reading and the withdrawal statuses.
 */
export type WcStatusPushEligibility =
  | 'eligible'
  | 'already-at-target'
  | 'ineligible-finalised'
  | 'ineligible-needs-operator'
  | 'ineligible-unknown'

export type WcStatusPushTarget = { wc: 'cancelled'; ims: 'CANCELLED' } | { wc: 'on-hold'; ims: 'ON_HOLD' }

/**
 * WooCommerce's OWN slugs and what each means for a cancel / hold, decided from the SLUG and never from the
 * mapping table. `processing` is here too: a row mapping it to CANCELLED or ON_HOLD (the status-mapping action
 * accepts any slug to any IMS status) must not make an in-flight order look already cancelled / held, because an
 * IMS state is evidence about the IMS order, not about what WooCommerce holds.
 */
const CANONICAL_PUSH_MEANING: Readonly<Record<string, SalesOrderStatus>> = {
  processing: 'PROCESSING',
  'on-hold': 'ON_HOLD',
  pending: 'PENDING_PAYMENT',
  failed: 'PENDING_PAYMENT',
}
/** IMS statuses a cancel or hold must never be pushed over: the order has left (or is leaving) the building. */
const NEVER_OVERWRITE_IMS_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'SHIPPED', 'COMPLETED', 'DELIVERED'])

export function classifyWcStatusPushEligibility(input: {
  reading: Pick<WcOrderStatusReading, 'slug' | 'imsStatus' | 'handledBy'>
  withdrawal: { submitted: string; approved: string }
  target: WcStatusPushTarget
}): WcStatusPushEligibility {
  const { reading, withdrawal, target } = input
  const slug = reading.slug

  // 1. WooCommerce's own slugs, by SLUG. `already-at-target` is ONLY ever the real target slug.
  if (slug === target.wc) return 'already-at-target'
  // `completed` and `refunded` (the built-in map reads `refunded` as PROCESSING, so ONLY this check refuses it).
  if (reading.handledBy !== null) return 'ineligible-finalised'
  // A hold never goes over a cancelled order. (For a cancel push `cancelled` was already-at-target above.)
  if (slug === 'cancelled') return 'ineligible-finalised'
  if (slug === WC_PARTIAL_SHIPPED_STATUS || slug === withdrawal.submitted || slug === withdrawal.approved) {
    return 'ineligible-needs-operator'
  }
  const canonical = Object.hasOwn(CANONICAL_PUSH_MEANING, slug) ? CANONICAL_PUSH_MEANING[slug] : null
  if (canonical !== null) return canTransitionSalesOrder(canonical, target.ims) ? 'eligible' : 'ineligible-unknown'

  // 2. A CUSTOM slug: the importer's reading (mapping) decides, through the state machine.
  const imsStatus = reading.imsStatus
  if (imsStatus === null) return 'ineligible-unknown'
  // The owner mapped a custom status to the very state being pushed. That says nothing certain about what
  // WooCommerce holds (the store may rely on its own handling of that status), so it is NEVER auto-succeeded and
  // NEVER overwritten: an operator decides. (An unconditional PUT would replace a status the owner configured;
  // a silent success would leave WooCommerce unchanged with no retry.)
  if (imsStatus === target.ims) return 'ineligible-needs-operator'
  if (NEVER_OVERWRITE_IMS_STATUSES.has(imsStatus)) return 'ineligible-finalised'
  return canTransitionSalesOrder(imsStatus, target.ims) ? 'eligible' : 'ineligible-unknown'
}

/** The classifier over the live reading: the importer's own mapping lookup plus the withdrawal settings. */
export async function readWcStatusPushEligibility(
  wcStatus: unknown,
  target: WcStatusPushTarget,
): Promise<{ eligibility: WcStatusPushEligibility; slug: string }> {
  const [{ readWcOrderStatus }, { getWithdrawalStatuses }] = await Promise.all([
    import('./status-mapping'),
    import('./withdrawal'),
  ])
  const reading = await readWcOrderStatus(wcStatus)
  const withdrawal = await getWithdrawalStatuses()
  return { eligibility: classifyWcStatusPushEligibility({ reading, withdrawal, target }), slug: reading.slug }
}
