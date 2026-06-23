import { Prisma } from '@/app/generated/prisma/client'

const MAX_KEY_PART_LENGTH = 200
const KEY_PART_RE = /^[A-Za-z0-9._-]+$/

function requireKeyPart(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Stock movement idempotency key ${label} must not be blank`)
  if (normalized.length > MAX_KEY_PART_LENGTH) {
    throw new Error(`Stock movement idempotency key ${label} must be ${MAX_KEY_PART_LENGTH} characters or fewer`)
  }
  if (!KEY_PART_RE.test(normalized)) {
    throw new Error(`Stock movement idempotency key ${label} contains invalid characters`)
  }
  return normalized
}

const SALE_DISPATCH_KEY_PREFIX = 'SALE_DISPATCH:shipmentLine:'

export function saleDispatchMovementKey(shipmentLineId: string): string {
  return `${SALE_DISPATCH_KEY_PREFIX}${requireKeyPart('shipmentLineId', shipmentLineId)}`
}

/// Inverse of saleDispatchMovementKey: extract the shipmentLineId encoded in a
/// SALE_DISPATCH idempotency key, or null when the key is absent or not a
/// sale-dispatch key. The backfill migration that populates
/// stock_movements.shipmentLineId relies on this same prefix; keep them in sync.
export function parseSaleDispatchMovementKey(idempotencyKey: string | null | undefined): string | null {
  if (!idempotencyKey || !idempotencyKey.startsWith(SALE_DISPATCH_KEY_PREFIX)) return null
  const shipmentLineId = idempotencyKey.slice(SALE_DISPATCH_KEY_PREFIX.length)
  return shipmentLineId.length > 0 ? shipmentLineId : null
}

export function wmsPurchaseReceiptMovementKey(params: {
  asnLineMapId: string
  receiptEventId: string
}): string {
  return wmsReceiptMovementKey('PURCHASE_RECEIPT', params)
}

export function wmsTransferInMovementKey(params: {
  asnLineMapId: string
  receiptEventId: string
}): string {
  return wmsReceiptMovementKey('TRANSFER_IN', params)
}

function wmsReceiptMovementKey(
  kind: 'PURCHASE_RECEIPT' | 'TRANSFER_IN',
  params: {
    asnLineMapId: string
    receiptEventId: string
  },
): string {
  return [
    kind,
    'wmsAsnLine',
    requireKeyPart('asnLineMapId', params.asnLineMapId),
    'receipt',
    requireKeyPart('receiptEventId', params.receiptEventId),
  ].join(':')
}

export function refundInboundMovementKey(params: {
  refundId: string
  refundLineId: string
  warehouseId: string
}): string {
  // Include both ids for operator triage: refundLineId provides uniqueness,
  // while refundId and warehouseId make grouped DB inspection straightforward
  // and keep split returns to different warehouses from colliding.
  return [
    'RETURN_INBOUND',
    'refund',
    requireKeyPart('refundId', params.refundId),
    'line',
    requireKeyPart('refundLineId', params.refundLineId),
    'warehouse',
    requireKeyPart('warehouseId', params.warehouseId),
  ].join(':')
}

export function isStockMovementIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = error.meta?.target
  return Array.isArray(target)
    ? target.includes('idempotencyKey')
    : String(target).includes('idempotencyKey')
}
