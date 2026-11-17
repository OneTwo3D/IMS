import { hasPermission, type Permission } from '@/lib/permissions'

/**
 * The "Needs attention" surface (dashboard card + bell). It is a VIEW over the sync exception inbox
 * (/sync/exceptions) and the two pages that already own the other failure rows — it is not a second
 * inbox. Every category therefore carries the route the operator is sent to and the permission that
 * lets them ACT there; a role that cannot act never sees the category (nor its count).
 */
export const NEEDS_ATTENTION_CATEGORY_KEYS = [
  'wmsPushBlocked',
  'dispatchDeadLetters',
  'refundParks',
  'operatorTasks',
  'refusedActions',
  'otherExceptions',
  'failedAccounting',
  'receiptReviews',
  'stockDiscrepancies',
] as const

export type NeedsAttentionCategoryKey = (typeof NEEDS_ATTENTION_CATEGORY_KEYS)[number]

export type NeedsAttentionCategory = {
  key: NeedsAttentionCategoryKey
  label: string
  /** One line saying what the number is, shown under the label. */
  detail: string
  /** An existing route (with an in-page anchor where the target page has one). */
  href: string
  /** Held by the roles that may act on the rows at `href`. */
  permission: Permission
}

export const NEEDS_ATTENTION_CATEGORIES: readonly NeedsAttentionCategory[] = [
  {
    key: 'wmsPushBlocked',
    label: 'Warehouse order pushes blocked',
    detail: 'Orders that never reached the warehouse (dead-lettered, invalid or ambiguous).',
    href: '/sync/exceptions#wms-push-blocked',
    permission: 'sync',
  },
  {
    key: 'dispatchDeadLetters',
    label: 'Dispatch reconciliation dead-lettered',
    detail: 'Warehouse despatches IMS could not reconcile into a shipment.',
    href: '/sync/exceptions#dispatch-dead-letters',
    permission: 'sync',
  },
  {
    key: 'refundParks',
    label: 'WooCommerce refunds parked',
    detail: 'Store refunds IMS could not apply and is holding for an operator.',
    href: '/sync/exceptions#refund-parks',
    permission: 'sync',
  },
  {
    key: 'operatorTasks',
    label: 'Warehouse queries to raise',
    detail: 'Open warehouse queries waiting for an operator.',
    href: '/sync/exceptions#wms-operator-tasks',
    permission: 'sync',
  },
  {
    key: 'refusedActions',
    label: 'Refused or stalled actions',
    detail: 'Actions a check refused or stalled (a change the warehouse could not take, a split order that cannot complete): serious and medium only.',
    href: '/sync/exceptions#refused-actions',
    permission: 'sync',
  },
  {
    key: 'otherExceptions',
    label: 'Other sync exceptions',
    detail: 'The rest of the exception inbox: outbox, dead events, drift, accounting follow-ups and refusals.',
    href: '/sync/exceptions',
    permission: 'sync',
  },
  {
    key: 'failedAccounting',
    label: 'Failed accounting sync rows',
    detail: 'Rows for the active accounting connector that ran out of retries.',
    href: '/sync',
    permission: 'sync',
  },
  {
    key: 'receiptReviews',
    label: 'Paused warehouse receipts',
    detail: 'Booked-in callbacks held for review before stock changes.',
    href: '/sync',
    // Approving a paused receipt is an administrator action (the review route is admin-only).
    permission: 'settings.company',
  },
  {
    key: 'stockDiscrepancies',
    label: 'Open stock discrepancies',
    detail: 'Warehouse stock that disagrees with IMS and has not been resolved.',
    href: '/sync',
    permission: 'sync',
  },
]

export type NeedsAttentionCounts = Record<NeedsAttentionCategoryKey, number>

export type NeedsAttentionRow = NeedsAttentionCategory & { count: number }

export type NeedsAttentionView = {
  rows: NeedsAttentionRow[]
  total: number
}

export function categoriesForRole(role: string): NeedsAttentionCategory[] {
  return NEEDS_ATTENTION_CATEGORIES.filter((category) => hasPermission(role, category.permission))
}

/**
 * Pure: the rows a role may see, with their counts, plus the total of THOSE rows. Zero-count
 * categories are dropped so the card lists only what needs a person.
 */
export function buildNeedsAttentionView(counts: Partial<NeedsAttentionCounts>, role: string): NeedsAttentionView {
  const rows = categoriesForRole(role)
    .map((category) => ({ ...category, count: Math.max(0, counts[category.key] ?? 0) }))
    .filter((row) => row.count > 0)
  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0) }
}
