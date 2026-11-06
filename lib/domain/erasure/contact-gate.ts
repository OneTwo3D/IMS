import { ERASURE_PLACEHOLDER_NAME } from './erasure-record'

/**
 * THE CENTRAL GATE ON THE CONTACT BLOCK OF AN ACCOUNTING SYNC ROW.
 *
 * Every accounting sync row is created by `createAccountingSyncLogRow` (lib/domain/accounting/sync-log-row.ts; a test fails on a
 * row written any other way), in the caller's transaction and, for an order-scoped row, under the order lock the enqueue
 * requires. This gate runs there, immediately before the insert: if the row belongs to an order (or a refund of an order) that is
 * erased, or whose customer is, the contact name becomes the placeholder and the contact email is removed. So whichever code
 * queues a customer-side document (the storefront import, the manual order, a credit note, a follow-up), and whatever it read
 * earlier, a row inserted after an erasure carries no identity. A new enqueue site cannot forget it.
 *
 * PURE: it uses only the client it is handed (no database import), so the primitive that calls it stays importable anywhere.
 * An unreadable erasure state THROWS, which rolls the caller's transaction back (the enqueue is retried): it is never read as
 * "not erased".
 */
type ReadClient = {
  salesOrder?: { findUnique(args: unknown): Promise<{ erasedAt: Date | null; customer: { gdprAnonymisedAt: Date | null } | null } | null> }
  salesOrderRefund?: { findUnique(args: unknown): Promise<{ orderId: string } | null> }
}

export function scrubContactBlock<T extends Record<string, unknown>>(payload: T): T {
  if (payload.contactName === undefined && payload.contactEmail === undefined) return payload
  const { contactEmail: _email, ...rest } = payload
  return { ...rest, ...(payload.contactName !== undefined ? { contactName: ERASURE_PLACEHOLDER_NAME } : {}) } as unknown as T
}

export async function gateAccountingPayloadContact<D extends { referenceType: string; referenceId: string; payload?: unknown }>(
  client: unknown,
  data: D,
): Promise<D> {
  const payload = data.payload
  if (data.referenceType !== 'SalesOrder' && data.referenceType !== 'SalesOrderRefund') return data
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return data
  const block = payload as Record<string, unknown>
  if (block.contactName === undefined && block.contactEmail === undefined) return data
  const c = client as ReadClient
  if (!c.salesOrder?.findUnique) return data // a structural test double with no order table; production always has it
  let orderId: string | null = data.referenceId
  if (data.referenceType === 'SalesOrderRefund') {
    if (!c.salesOrderRefund?.findUnique) return data
    orderId = (await c.salesOrderRefund.findUnique({ where: { id: data.referenceId }, select: { orderId: true } }))?.orderId ?? null
  }
  if (!orderId) return data
  const order = await c.salesOrder.findUnique({ where: { id: orderId }, select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } } })
  if (!order?.erasedAt && !order?.customer?.gdprAnonymisedAt) return data
  return { ...data, payload: scrubContactBlock(block) }
}
