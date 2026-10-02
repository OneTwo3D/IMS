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
