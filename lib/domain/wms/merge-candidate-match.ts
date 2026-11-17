import { createHash } from 'node:crypto'
import { resolvePushRecipient } from '@/lib/domain/wms/push-recipient'

/**
 * MERGE CANDIDATES: THE MATCHING RULES (pure; no database, no network).
 *
 * Two or more of a customer's OPEN orders are a merge candidate group when
 *   - they carry the same normalised billing email, and
 *   - the same effective delivery address (street line 1, line 2, city, postcode, country), where the delivery address is the shipping
 *     address, or the billing address when the shipping address has no street line (the push recipient rule, shared with the warehouse push), and
 *   - the warehouse order each is linked to is still NEW (read from the stored status snapshot: this module makes no warehouse call), is the
 *     same tenant's, and is a DIFFERENT warehouse order (orders already merged into one warehouse order collapse to one).
 *
 * Case, spacing and punctuation are ignored. A group of three or more (a chain) is one group.
 *
 * Excluded: orders with a backordered line (decided by the caller, passed in as `excludedOrderIds`) and orders with a pending or approved
 * withdrawal. EU destinations are flagged WITH a customs / IOSS warning; NI, JE, GG and IM count as UK. A group that is to ship by FedEx gets
 * a "label by hand" warning. IMS never merges: nothing here is an instruction to the warehouse; a person decides.
 */

/** IMS statuses of an order that can still be fulfilled and is not held. */
export const MERGE_OPEN_STATUSES: readonly string[] = ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING']

/** A status snapshot older than this is not evidence that the warehouse order is still NEW (the status sweep refreshes it every 30 minutes). */
export const MERGE_SNAPSHOT_MAX_AGE_MS = 3 * 60 * 60 * 1000

/** Link states that name a live warehouse order. A MERGED link points at the survivor and is collapsed with it. */
export const MERGE_LINK_STATES: readonly string[] = ['SYNCED', 'MERGED']

export const MERGE_WARNING_EU = 'EU destination: the merged parcel crosses a customs border. Check the customs declaration and the IOSS number before you merge.'
export const MERGE_WARNING_FEDEX = 'FedEx: IMS does not create the label for a merged FedEx order. Create the label by hand after you merge.'

const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

/** Country codes that count as the UK here: Great Britain and the UK spellings, Northern Ireland, and the Crown Dependencies. */
const UK_COUNTRIES: ReadonlySet<string> = new Set(['GB', 'UK', 'XI', 'NI', 'JE', 'GG', 'IM'])

/** Lower-case, accents removed, every character that is not a letter or a digit removed (spacing and punctuation are ignored). */
export function normaliseMergeText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function normaliseMergeEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/** A two-letter country code, with the UK spellings and UK-like territories folded to GB and Greece's EL to GR. Anything else is returned normalised. */
export function normaliseMergeCountry(value: string | null | undefined): string {
  const code = (value ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '')
  if (UK_COUNTRIES.has(code)) return 'GB'
  if (code === 'EL') return 'GR'
  return code
}

export function isEuMergeCountry(country: string): boolean {
  return EU_COUNTRIES.has(country)
}

export type MergeCandidateOrder = {
  orderId: string
  orderNumber: string | null
  createdAt: Date
  status: string
  shippedAt: Date | null
  refundStatus: string
  withdrawalHoldAt: Date | null
  withdrawalApprovedAt: Date | null
  erasedAt: Date | null
  archived: boolean
  customerName: string | null
  customerEmail: string | null
  billingAddress: unknown
  shippingAddress: unknown
  /** The values that say how the order ships: shipping label, courier key, method id. */
  courierText: ReadonlyArray<string | null | undefined>
  link: { connector: string; state: string; externalOrderId: string | null; externalOrderNumber: string | null } | null
  snapshot: {
    connector: string
    status: string
    externalOrderId: string
    externalOrderNumber: string
    isSplit: boolean
    fetchedAt: Date
    lastError: string | null
  } | null
}

export type MergeCandidateContext = {
  /** The connector that is active now. */
  connectorId: string
  /** Whether the warehouse connection is scoped to one client (ClientId configured): every stored status was read through a ClientId-scoped lookup. */
  tenantScoped: boolean
  now: Date
  /** Orders to leave out (a backordered line). Decided by the caller, which reads the allocation state. */
  excludedOrderIds?: ReadonlySet<string>
}

export type MergeGroupMember = {
  orderId: string
  orderNumber: string | null
  externalOrderId: string
  externalOrderNumber: string
}

export type MergeGroup = {
  /** Stable identity of the set of orders (not of the customer: it holds no personal data). */
  basis: string
  members: MergeGroupMember[]
  warnings: string[]
}

/** The reasons an order never enters a group. One place, so tests and the explanation read the same list. */
export function mergeIneligibleReason(order: MergeCandidateOrder, ctx: MergeCandidateContext): string | null {
  if (ctx.excludedOrderIds?.has(order.orderId)) return 'backordered line'
  if (!MERGE_OPEN_STATUSES.includes(order.status)) return 'not open'
  if (order.shippedAt || order.archived || order.erasedAt) return 'not open'
  if (order.refundStatus === 'FULL') return 'fully refunded'
  if (order.withdrawalHoldAt || order.withdrawalApprovedAt) return 'pending withdrawal'
  const { link, snapshot } = order
  if (!ctx.tenantScoped) return 'warehouse client not configured'
  if (!link || !snapshot) return 'no warehouse status'
  if (link.connector !== ctx.connectorId || snapshot.connector !== ctx.connectorId) return 'other connector'
  if (!MERGE_LINK_STATES.includes(link.state)) return 'not live in the warehouse'
  if (!link.externalOrderId || !snapshot.externalOrderId || link.externalOrderId !== snapshot.externalOrderId) return 'warehouse order does not match the link'
  if (snapshot.lastError) return 'warehouse status unreadable'
  if (snapshot.isSplit) return 'split in the warehouse'
  if (snapshot.status.trim().toUpperCase() !== 'NEW') return 'not NEW in the warehouse'
  if (ctx.now.getTime() - snapshot.fetchedAt.getTime() > MERGE_SNAPSHOT_MAX_AGE_MS) return 'warehouse status is stale'
  return null
}

/** The matching key, or null when the order has no usable email or no street line. */
export function mergeMatchKey(order: Pick<MergeCandidateOrder, 'billingAddress' | 'shippingAddress' | 'customerEmail' | 'customerName'>): { key: string; country: string } | null {
  const billing = order.billingAddress && typeof order.billingAddress === 'object' && !Array.isArray(order.billingAddress) ? (order.billingAddress as Record<string, unknown>) : {}
  const billingEmail = typeof billing.email === 'string' ? billing.email : null
  const email = normaliseMergeEmail(billingEmail ?? order.customerEmail)
  if (!email) return null
  const { address } = resolvePushRecipient({
    shippingAddress: order.shippingAddress, billingAddress: order.billingAddress, customerName: order.customerName, customerEmail: null,
  })
  const line1 = normaliseMergeText(address.address1)
  if (!line1) return null
  const country = normaliseMergeCountry(address.country)
  const key = [email, line1, normaliseMergeText(address.address2), normaliseMergeText(address.town), normaliseMergeText(address.postCode), country].join('\u0000')
  return { key, country }
}

function sortOrders(a: MergeCandidateOrder, b: MergeCandidateOrder): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0)
}

export function mergeGroupBasis(orderIds: readonly string[]): string {
  return `merge-candidate:${[...orderIds].sort().join(',')}`
}

/** Every merge candidate group among the given orders. Deterministic: members are oldest first and groups are ordered by their oldest member. */
export function findMergeCandidateGroups(orders: readonly MergeCandidateOrder[], ctx: MergeCandidateContext): MergeGroup[] {
  const buckets = new Map<string, { country: string; orders: MergeCandidateOrder[] }>()
  for (const order of [...orders].sort(sortOrders)) {
    if (mergeIneligibleReason(order, ctx) !== null) continue
    const match = mergeMatchKey(order)
    if (!match) continue
    const bucket = buckets.get(match.key) ?? { country: match.country, orders: [] }
    bucket.orders.push(order)
    buckets.set(match.key, bucket)
  }
  const groups: Array<{ group: MergeGroup; oldest: MergeCandidateOrder }> = []
  for (const bucket of buckets.values()) {
    // Orders already merged into one warehouse order share its id: that is one warehouse order, kept once (its oldest IMS order).
    const byWarehouseOrder = new Map<string, MergeCandidateOrder>()
    for (const order of bucket.orders) {
      const id = order.snapshot!.externalOrderId
      if (!byWarehouseOrder.has(id)) byWarehouseOrder.set(id, order)
    }
    const distinct = [...byWarehouseOrder.values()].sort(sortOrders)
    if (distinct.length < 2) continue
    const warnings: string[] = []
    if (isEuMergeCountry(bucket.country)) warnings.push(MERGE_WARNING_EU)
    if (distinct.some((order) => order.courierText.some((value) => typeof value === 'string' && /fedex/i.test(value)))) warnings.push(MERGE_WARNING_FEDEX)
    groups.push({
      group: {
        basis: mergeGroupBasis(distinct.map((order) => order.orderId)),
        members: distinct.map((order) => ({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          externalOrderId: order.snapshot!.externalOrderId,
          externalOrderNumber: order.snapshot!.externalOrderNumber,
        })),
        warnings,
      },
      oldest: distinct[0],
    })
  }
  return groups.sort((a, b) => sortOrders(a.oldest, b.oldest)).map((entry) => entry.group)
}

/** A short stable hash of a group (for logs and keys that must not carry order numbers). */
export function mergeGroupId(group: Pick<MergeGroup, 'basis'>): string {
  return createHash('sha256').update(group.basis).digest('hex').slice(0, 16)
}
