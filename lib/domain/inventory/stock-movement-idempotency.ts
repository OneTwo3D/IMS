import { Prisma } from '@/app/generated/prisma/client'

function requireKeyPart(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Stock movement idempotency key ${label} must not be blank`)
  if (normalized.includes(':')) throw new Error(`Stock movement idempotency key ${label} must not contain ":"`)
  return normalized
}

export function saleDispatchMovementKey(shipmentLineId: string): string {
  return `SALE_DISPATCH:shipmentLine:${requireKeyPart('shipmentLineId', shipmentLineId)}`
}

export function wmsPurchaseReceiptMovementKey(params: {
  asnLineMapId: string
  receiptEventId: string
}): string {
  return [
    'PURCHASE_RECEIPT',
    'wmsAsnLine',
    requireKeyPart('asnLineMapId', params.asnLineMapId),
    'receipt',
    requireKeyPart('receiptEventId', params.receiptEventId),
  ].join(':')
}

export function wmsTransferInMovementKey(params: {
  asnLineMapId: string
  receiptEventId: string
}): string {
  return [
    'TRANSFER_IN',
    'wmsAsnLine',
    requireKeyPart('asnLineMapId', params.asnLineMapId),
    'receipt',
    requireKeyPart('receiptEventId', params.receiptEventId),
  ].join(':')
}

export function refundInboundMovementKey(params: {
  refundId: string
  refundLineId: string
}): string {
  return [
    'RETURN_INBOUND',
    'refund',
    requireKeyPart('refundId', params.refundId),
    'line',
    requireKeyPart('refundLineId', params.refundLineId),
  ].join(':')
}

export function isStockMovementIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = error.meta?.target
  return Array.isArray(target)
    ? target.includes('idempotencyKey')
    : String(target).includes('idempotencyKey')
}
