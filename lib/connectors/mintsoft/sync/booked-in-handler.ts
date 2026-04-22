import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { fetchMintsoftAsns } from '@/lib/connectors/mintsoft'
import { copyCostLayerSourceLinesProportionally, createCostLayer } from '@/lib/cost-layers'
import { reconcileBookedInQuantities, sliceTransferSnapshotForReceipt } from './booked-in-helpers'
import { enqueueStockSync } from '@/lib/shopping'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }
const PENDING_ASN_FINALIZATION_REASON_PREFIX = 'PENDING_ASN_FINALIZATION:'
const WEBHOOK_SWEEPER_MAX_EVENTS_PER_RUN = 250
const WEBHOOK_SWEEPER_SCAN_LIMIT = 5000
const WEBHOOK_RETRY_STATE_PREFIX = 'RETRY_STATE:'
const MAX_PENDING_ATTEMPTS = 12
const MAX_FAILED_ATTEMPTS = 8
const PENDING_RETRY_BASE_MS = 60 * 1000
const FAILED_RETRY_BASE_MS = 5 * 60 * 1000
const MAX_PENDING_RETRY_MS = 30 * 60 * 1000
const MAX_FAILED_RETRY_MS = 60 * 60 * 1000

type WebhookRetryState = {
  kind: 'pending' | 'failed' | 'dead'
  attempts: number
  nextRetryAt: string | null
  message: string
}

type ProcessMintsoftBookedInResult =
  | {
    status: 'processed'
    eventId: string
    externalAsnId: string
    productIds: string[]
  }
  | {
    status: 'duplicate'
    eventId: string
    externalAsnId: string | null
  }
  | {
    status: 'pending'
    eventId: string
    externalAsnId: string | null
    reason: string
  }
  | {
    status: 'failed'
    eventId: string
    externalAsnId: string | null
    error: string
  }

function formatReceiptReference(externalAsnId: string, poReference: string): string {
  const normalizedAsnId = externalAsnId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'ASN'
  return `MS-${normalizedAsnId}-${poReference}`.slice(0, 100)
}

async function fetchMintsoftAsnById(externalAsnId: string) {
  const asns = await fetchMintsoftAsns()
  return asns.find((asn) => asn.externalAsnId === externalAsnId) ?? null
}

async function markEventFailed(eventId: string, error: string): Promise<void> {
  await scheduleWebhookRetry(eventId, 'failed', error)
}

async function markEventPending(eventId: string, reason: string): Promise<void> {
  await scheduleWebhookRetry(eventId, 'pending', normalizePendingReason(reason))
}

function normalizePendingReason(reason: string): string {
  return reason.startsWith(PENDING_ASN_FINALIZATION_REASON_PREFIX)
    ? reason
    : `${PENDING_ASN_FINALIZATION_REASON_PREFIX}${reason}`
}

function parseWebhookRetryState(value: string | null | undefined): WebhookRetryState | null {
  if (typeof value !== 'string' || !value.startsWith(WEBHOOK_RETRY_STATE_PREFIX)) return null
  try {
    const parsed = JSON.parse(value.slice(WEBHOOK_RETRY_STATE_PREFIX.length)) as Partial<WebhookRetryState>
    if (
      (parsed.kind === 'pending' || parsed.kind === 'failed' || parsed.kind === 'dead')
      && typeof parsed.attempts === 'number'
      && (parsed.nextRetryAt === null || typeof parsed.nextRetryAt === 'string')
      && typeof parsed.message === 'string'
    ) {
      return parsed as WebhookRetryState
    }
  } catch {
    return null
  }
  return null
}

function serializeWebhookRetryState(state: WebhookRetryState): string {
  return `${WEBHOOK_RETRY_STATE_PREFIX}${JSON.stringify(state)}`
}

function buildNextRetryDelayMs(kind: 'pending' | 'failed', attempts: number): number {
  const baseMs = kind === 'pending' ? PENDING_RETRY_BASE_MS : FAILED_RETRY_BASE_MS
  const capMs = kind === 'pending' ? MAX_PENDING_RETRY_MS : MAX_FAILED_RETRY_MS
  return Math.min(baseMs * (2 ** Math.max(attempts - 1, 0)), capMs)
}

async function scheduleWebhookRetry(
  eventId: string,
  kind: 'pending' | 'failed',
  message: string,
): Promise<void> {
  const event = await db.wmsInboundReceiptEvent.findUnique({
    where: { id: eventId },
    select: {
      processingError: true,
    },
  })

  const previous = parseWebhookRetryState(event?.processingError)
  const attempts = (previous?.attempts ?? 0) + 1
  const maxAttempts = kind === 'pending' ? MAX_PENDING_ATTEMPTS : MAX_FAILED_ATTEMPTS

  if (attempts >= maxAttempts) {
    await db.wmsInboundReceiptEvent.update({
      where: { id: eventId },
      data: {
        processingError: serializeWebhookRetryState({
          kind: 'dead',
          attempts,
          nextRetryAt: null,
          message,
        }),
      },
    })
    return
  }

  const nextRetryAt = new Date(Date.now() + buildNextRetryDelayMs(kind, attempts))
  await db.wmsInboundReceiptEvent.update({
    where: { id: eventId },
    data: {
      processingError: serializeWebhookRetryState({
        kind,
        attempts,
        nextRetryAt: nextRetryAt.toISOString(),
        message,
      }),
    },
  })
}

export async function processMintsoftBookedInEvent(
  eventId: string,
): Promise<ProcessMintsoftBookedInResult> {
  const event = await db.wmsInboundReceiptEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      externalAsnId: true,
      processedAt: true,
    },
  })

  if (!event) {
    return {
      status: 'failed',
      eventId,
      externalAsnId: null,
      error: 'Webhook event not found',
    }
  }

  if (event.processedAt) {
    return {
      status: 'duplicate',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
    }
  }

  if (!event.externalAsnId) {
    const error = 'Webhook payload did not include an ASN id'
    await markEventFailed(event.id, error)
    return {
      status: 'failed',
      eventId: event.id,
      externalAsnId: null,
      error,
    }
  }

  try {
    const mappedAsn = await db.wmsAsnMap.findUnique({
      where: {
        connector_externalAsnId: {
          connector: 'mintsoft',
          externalAsnId: event.externalAsnId,
        },
      },
      select: { id: true },
    })
    const remoteAsn = mappedAsn
      ? await fetchMintsoftAsnById(event.externalAsnId)
      : null

    const processed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM wms_inbound_receipt_events WHERE id = ${event.id} FOR UPDATE`

      const lockedEvent = await tx.wmsInboundReceiptEvent.findUnique({
        where: { id: event.id },
        select: {
          id: true,
          externalAsnId: true,
          processedAt: true,
        },
      })

      if (!lockedEvent) {
        throw new Error('Webhook event disappeared during processing')
      }
      if (lockedEvent.processedAt) {
        return {
          duplicate: true,
          productIds: [] as string[],
        }
      }
      if (!lockedEvent.externalAsnId) {
        throw new Error('Webhook payload did not include an ASN id')
      }

      const asnMap = await tx.wmsAsnMap.findUnique({
        where: {
          connector_externalAsnId: {
            connector: 'mintsoft',
            externalAsnId: lockedEvent.externalAsnId,
          },
        },
        select: {
          id: true,
          externalAsnId: true,
          warehouseId: true,
        },
      })

      if (!asnMap) {
        return {
          duplicate: false,
          pending: true,
          pendingReason: normalizePendingReason(`ASN ${lockedEvent.externalAsnId} is not mapped yet; waiting for ASN finalization`),
          productIds: [] as string[],
        }
      }

      if (!remoteAsn) {
        return {
          duplicate: false,
          pending: true,
          pendingReason: `ASN ${lockedEvent.externalAsnId} is not available from Mintsoft yet; retrying booked-in reconciliation`,
          productIds: [] as string[],
        }
      }

      const lineIds = await tx.wmsAsnLineMap.findMany({
        where: {
          asnMapId: asnMap.id,
        },
        select: {
          id: true,
        },
      })
      if (lineIds.length > 0) {
        await tx.$executeRaw`SELECT id FROM wms_asn_line_maps WHERE id = ANY(${lineIds.map((line) => line.id)}::text[]) FOR UPDATE`
      }

      const asnLines = await tx.wmsAsnLineMap.findMany({
        where: {
          asnMapId: asnMap.id,
        },
        select: {
          id: true,
          externalAsnLineId: true,
          sourceType: true,
          sourceLineId: true,
          productId: true,
          sku: true,
          expectedQty: true,
          qtyAccountedViaSnapshot: true,
          qtyAccountedViaReceipt: true,
          lastProcessedReceivedQty: true,
        },
      })

      const remoteLineByExternalId = new Map(remoteAsn.lines.map((line) => [line.externalLineId, line]))
      const remoteLineBySourceId = new Map(remoteAsn.lines.map((line) => [line.sourceLineId, line]))

      const candidateLines = asnLines
        .map((line) => {
          const remoteLine = remoteLineByExternalId.get(line.externalAsnLineId)
            ?? remoteLineBySourceId.get(line.sourceLineId)
          return {
            ...line,
            currentReceivedQty: Math.min(
              Number(line.expectedQty),
              Math.max(0, Number(remoteLine?.quantity ?? 0)),
            ),
          }
        })
      const regressedLines = candidateLines.filter((line) => (
        line.currentReceivedQty + 0.0001 < Math.max(
          Number(line.lastProcessedReceivedQty),
          Number(line.qtyAccountedViaSnapshot),
        )
      ))
      if (regressedLines.length > 0) {
        const first = regressedLines[0]
        throw new Error(
          `Mintsoft received quantity regressed for ASN ${lockedEvent.externalAsnId} on ${first?.sku ?? 'unknown SKU'}; manual reconciliation is required before snapshot credits can be changed.`,
        )
      }

      const actionableLines = candidateLines
        .filter((line) => line.currentReceivedQty > Number(line.lastProcessedReceivedQty))

      const unsupportedLines = actionableLines.filter((line) => (
        line.sourceType !== 'PURCHASE_ORDER_LINE' && line.sourceType !== 'STOCK_TRANSFER_LINE'
      ))
      if (unsupportedLines.length > 0) {
        const kinds = Array.from(new Set(unsupportedLines.map((line) => line.sourceType))).join(', ')
        throw new Error(`ASN ${lockedEvent.externalAsnId} contains unsupported line source types: ${kinds}`)
      }

      const purchaseActionableLines = actionableLines.filter((line) => line.sourceType === 'PURCHASE_ORDER_LINE')
      const transferActionableLines = actionableLines.filter((line) => line.sourceType === 'STOCK_TRANSFER_LINE')

      const purchaseOrderLines = purchaseActionableLines.length > 0
        ? await tx.purchaseOrderLine.findMany({
            where: {
              id: {
                in: purchaseActionableLines.map((line) => line.sourceLineId),
              },
            },
            select: {
              id: true,
              poId: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              unitCostBase: true,
              landedUnitCostBase: true,
              po: {
                select: {
                  id: true,
                  reference: true,
                  status: true,
                },
              },
            },
          })
        : []

      const transferLines = transferActionableLines.length > 0
        ? await tx.stockTransferLine.findMany({
            where: {
              id: {
                in: transferActionableLines.map((line) => line.sourceLineId),
              },
            },
            select: {
              id: true,
              transferId: true,
              productId: true,
              qty: true,
              qtyReceived: true,
              costLayerSnapshot: true,
            },
          })
        : []

      const purchaseLineById = new Map(purchaseOrderLines.map((line) => [line.id, line]))
      const transferLineById = new Map(transferLines.map((line) => [line.id, line]))
      const receiptLinesByPoId = new Map<string, Array<{
        asnLineMapId: string
        poLineId: string
        productId: string
        expectedQty: number
        qtyAccountedViaSnapshot: number
        qtyAccountedViaReceipt: number
        currentReceivedQty: number
        lastProcessedReceivedQty: number
      }>>()
      const receiptLinesByTransferId = new Map<string, Array<{
        asnLineMapId: string
        transferLineId: string
        productId: string
        expectedQty: number
        qtyAccountedViaSnapshot: number
        qtyAccountedViaReceipt: number
        currentReceivedQty: number
        lastProcessedReceivedQty: number
      }>>()

      for (const line of actionableLines) {
        if (line.sourceType === 'PURCHASE_ORDER_LINE') {
          const poLine = purchaseLineById.get(line.sourceLineId)
          if (!poLine) {
            throw new Error(`Missing purchase order line ${line.sourceLineId} for ASN ${lockedEvent.externalAsnId}`)
          }

          const entry = receiptLinesByPoId.get(poLine.poId) ?? []
          entry.push({
            asnLineMapId: line.id,
            poLineId: poLine.id,
            productId: poLine.productId,
            expectedQty: Number(line.expectedQty),
            qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
            qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
            currentReceivedQty: line.currentReceivedQty,
            lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
          })
          receiptLinesByPoId.set(poLine.poId, entry)
          continue
        }

        const transferLine = transferLineById.get(line.sourceLineId)
        if (!transferLine) {
          throw new Error(`Missing transfer line ${line.sourceLineId} for ASN ${lockedEvent.externalAsnId}`)
        }

        const entry = receiptLinesByTransferId.get(transferLine.transferId) ?? []
        entry.push({
          asnLineMapId: line.id,
          transferLineId: transferLine.id,
          productId: transferLine.productId,
          expectedQty: Number(line.expectedQty),
          qtyAccountedViaSnapshot: Number(line.qtyAccountedViaSnapshot),
          qtyAccountedViaReceipt: Number(line.qtyAccountedViaReceipt),
          currentReceivedQty: line.currentReceivedQty,
          lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
        })
        receiptLinesByTransferId.set(transferLine.transferId, entry)
      }

      const now = new Date()
      const touchedProductIds = new Set<string>()

      for (const [poId, receiptLines] of receiptLinesByPoId) {
        await tx.$executeRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`

        const po = await tx.purchaseOrder.findUnique({
          where: { id: poId },
          select: {
            id: true,
            reference: true,
            status: true,
            lines: {
              select: {
                id: true,
                productId: true,
                qty: true,
                qtyReceived: true,
                unitCostBase: true,
                landedUnitCostBase: true,
              },
            },
          },
        })

        if (!po) {
          throw new Error(`Purchase order ${poId} not found for ASN ${lockedEvent.externalAsnId}`)
        }

        const lockedLineById = new Map(po.lines.map((line) => [line.id, line]))
        const reconciledLines = receiptLines.map((receiptLine) => {
          const poLine = lockedLineById.get(receiptLine.poLineId)
          if (!poLine) {
            throw new Error(`Purchase order line ${receiptLine.poLineId} not found on locked PO ${po.reference}`)
          }

          const reconciled = reconcileBookedInQuantities({
            expectedQty: receiptLine.expectedQty,
            currentReceivedQty: receiptLine.currentReceivedQty,
            localReceivedQty: Number(poLine.qtyReceived),
            lastProcessedReceivedQty: receiptLine.lastProcessedReceivedQty,
            qtyAccountedViaSnapshot: receiptLine.qtyAccountedViaSnapshot,
            qtyAccountedViaReceipt: receiptLine.qtyAccountedViaReceipt,
          })

          return {
            ...receiptLine,
            qtyReceived: reconciled.qtyReceived,
            reconciledManualQty: reconciled.reconciledManualQty,
            coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
            stockQtyToAdd: reconciled.stockQtyToAdd,
            newlyProcessedQty: reconciled.newlyProcessedQty,
          }
        }).filter((receiptLine) => receiptLine.qtyReceived > 0 || receiptLine.reconciledManualQty > 0)

        const createdReceiptLines = reconciledLines.filter((receiptLine) => receiptLine.qtyReceived > 0)
        if (createdReceiptLines.length > 0) {
          await tx.purchaseReceipt.create({
            data: {
              poId,
              reference: formatReceiptReference(lockedEvent.externalAsnId, po.reference),
              externalKey: `mintsoft:po:${poId}:event:${lockedEvent.id}`,
              notes: `Mintsoft ASN booked-in webhook ${lockedEvent.externalAsnId}`,
              lines: {
                create: createdReceiptLines.map((receiptLine) => ({
                  poLineId: receiptLine.poLineId,
                  qtyReceived: receiptLine.qtyReceived,
                  coveredBySnapshotQty: receiptLine.coveredBySnapshotQty,
                  warehouseId: asnMap.warehouseId,
                })),
              },
            },
          })
        }

        for (const receiptLine of reconciledLines) {
          const poLine = lockedLineById.get(receiptLine.poLineId)
          if (!poLine) continue

          if (receiptLine.qtyReceived > 0) {
            const unitCostBase = Number(poLine.landedUnitCostBase ?? poLine.unitCostBase)
            if (receiptLine.stockQtyToAdd > 0) {
              await tx.stockMovement.create({
                data: {
                  type: 'PURCHASE_RECEIPT',
                  productId: poLine.productId,
                  toWarehouseId: asnMap.warehouseId,
                  qty: receiptLine.stockQtyToAdd,
                  note: `Received against ${po.reference} via Mintsoft webhook ${lockedEvent.externalAsnId}`,
                  referenceType: 'WmsAsnMap',
                  referenceId: asnMap.id,
                },
              })

              await tx.costLayer.create({
                data: {
                  productId: poLine.productId,
                  warehouseId: asnMap.warehouseId,
                  receivedQty: receiptLine.stockQtyToAdd,
                  remainingQty: receiptLine.stockQtyToAdd,
                  unitCostBase,
                  poLineId: poLine.id,
                  isOpeningStock: false,
                },
              })

              await tx.stockLevel.upsert({
                where: {
                  productId_warehouseId: {
                    productId: poLine.productId,
                    warehouseId: asnMap.warehouseId,
                  },
                },
                create: {
                  productId: poLine.productId,
                  warehouseId: asnMap.warehouseId,
                  quantity: receiptLine.stockQtyToAdd,
                  reservedQty: 0,
                },
                update: {
                  quantity: { increment: receiptLine.stockQtyToAdd },
                },
              })
            }

            if (receiptLine.coveredBySnapshotQty > 0) {
              await tx.stockMovement.create({
                data: {
                  type: 'WMS_RECEIPT_RECONCILIATION',
                  productId: poLine.productId,
                  toWarehouseId: asnMap.warehouseId,
                  qty: 0,
                  note: `Mintsoft snapshot already accounted for ${receiptLine.coveredBySnapshotQty} on ${po.reference}`,
                  referenceType: 'WmsAsnLineMap',
                  referenceId: receiptLine.asnLineMapId,
                },
              })
            }

            await tx.purchaseOrderLine.update({
              where: { id: poLine.id },
              data: {
                qtyReceived: { increment: receiptLine.qtyReceived },
              },
            })

            touchedProductIds.add(poLine.productId)
          }

          await tx.wmsAsnLineMap.update({
            where: { id: receiptLine.asnLineMapId },
            data: {
              qtyAccountedViaReceipt: { increment: receiptLine.newlyProcessedQty },
              lastProcessedReceivedQty: { increment: receiptLine.newlyProcessedQty },
              lastCallbackAt: now,
            },
          })
        }

        const updatedLines = await tx.purchaseOrderLine.findMany({
          where: { poId },
          select: {
            qty: true,
            qtyReceived: true,
          },
        })
        const allReceived = updatedLines.every((line) => Number(line.qtyReceived) >= Number(line.qty))
        await tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
            ...(allReceived ? { receivedAt: now } : {}),
          },
        })
      }

      for (const [transferId, receiptLines] of receiptLinesByTransferId) {
        await tx.$executeRaw`SELECT id FROM stock_transfers WHERE id = ${transferId} FOR UPDATE`

        const transfer = await tx.stockTransfer.findUnique({
          where: { id: transferId },
          select: {
            id: true,
            reference: true,
            status: true,
            toWarehouseId: true,
            completedAt: true,
            lines: {
              select: {
                id: true,
                productId: true,
                qty: true,
                qtyReceived: true,
                costLayerSnapshot: true,
              },
            },
          },
        })

        if (!transfer) {
          throw new Error(`Transfer ${transferId} not found for ASN ${lockedEvent.externalAsnId}`)
        }

        if (!['IN_TRANSIT', 'RECEIVED'].includes(transfer.status)) {
          throw new Error(`Transfer ${transfer.reference} is not in transit for ASN ${lockedEvent.externalAsnId}`)
        }

        const lockedLineById = new Map(transfer.lines.map((line) => [line.id, line]))
        const reconciledLines = receiptLines.map((receiptLine) => {
          const transferLine = lockedLineById.get(receiptLine.transferLineId)
          if (!transferLine) {
            throw new Error(`Transfer line ${receiptLine.transferLineId} not found on locked transfer ${transfer.reference}`)
          }

          const reconciled = reconcileBookedInQuantities({
            expectedQty: receiptLine.expectedQty,
            currentReceivedQty: receiptLine.currentReceivedQty,
            localReceivedQty: Number(transferLine.qtyReceived),
            lastProcessedReceivedQty: receiptLine.lastProcessedReceivedQty,
            qtyAccountedViaSnapshot: receiptLine.qtyAccountedViaSnapshot,
            qtyAccountedViaReceipt: receiptLine.qtyAccountedViaReceipt,
          })

          return {
            ...receiptLine,
            qtyReceived: reconciled.qtyReceived,
            reconciledManualQty: reconciled.reconciledManualQty,
            coveredBySnapshotQty: reconciled.coveredBySnapshotQty,
            stockQtyToAdd: reconciled.stockQtyToAdd,
            newlyProcessedQty: reconciled.newlyProcessedQty,
            alreadyReceivedQty: Math.max(
              Number(transferLine.qtyReceived),
              receiptLine.qtyAccountedViaSnapshot,
            ),
          }
        }).filter((receiptLine) => receiptLine.qtyReceived > 0 || receiptLine.reconciledManualQty > 0)

        for (const receiptLine of reconciledLines) {
          const transferLine = lockedLineById.get(receiptLine.transferLineId)
          if (!transferLine) continue

          if (receiptLine.qtyReceived > 0) {
            if (receiptLine.stockQtyToAdd > 0) {
              await tx.stockMovement.create({
                data: {
                  type: 'TRANSFER_IN',
                  productId: transferLine.productId,
                  fromWarehouseId: null,
                  toWarehouseId: transfer.toWarehouseId,
                  qty: receiptLine.stockQtyToAdd,
                  note: `Received against ${transfer.reference} via Mintsoft webhook ${lockedEvent.externalAsnId}`,
                  referenceType: 'WmsAsnMap',
                  referenceId: asnMap.id,
                },
              })

              await tx.stockLevel.upsert({
                where: {
                  productId_warehouseId: {
                    productId: transferLine.productId,
                    warehouseId: transfer.toWarehouseId,
                  },
                },
                create: {
                  productId: transferLine.productId,
                  warehouseId: transfer.toWarehouseId,
                  quantity: receiptLine.stockQtyToAdd,
                  reservedQty: 0,
                },
                update: {
                  quantity: { increment: receiptLine.stockQtyToAdd },
                },
              })

              const snapshotSlice = sliceTransferSnapshotForReceipt({
                snapshot: transferLine.costLayerSnapshot,
                alreadyReceivedQty: receiptLine.alreadyReceivedQty,
                qtyReceived: receiptLine.stockQtyToAdd,
              })

              for (const entry of snapshotSlice) {
                const newLayerId = await createCostLayer(tx, {
                  productId: transferLine.productId,
                  warehouseId: transfer.toWarehouseId,
                  qty: entry.qty,
                  unitCostBase: entry.unitCostBase,
                })
                await copyCostLayerSourceLinesProportionally(tx, entry.costLayerId, newLayerId, entry.qty)
              }
            }

            if (receiptLine.coveredBySnapshotQty > 0) {
              await tx.stockMovement.create({
                data: {
                  type: 'WMS_RECEIPT_RECONCILIATION',
                  productId: transferLine.productId,
                  toWarehouseId: transfer.toWarehouseId,
                  qty: 0,
                  note: `Mintsoft snapshot already accounted for ${receiptLine.coveredBySnapshotQty} on ${transfer.reference}`,
                  referenceType: 'WmsAsnLineMap',
                  referenceId: receiptLine.asnLineMapId,
                },
              })
            }

            await tx.stockTransferLine.update({
              where: { id: transferLine.id },
              data: {
                qtyReceived: { increment: receiptLine.qtyReceived },
              },
            })

            touchedProductIds.add(transferLine.productId)
          }

          await tx.wmsAsnLineMap.update({
            where: { id: receiptLine.asnLineMapId },
            data: {
              qtyAccountedViaReceipt: { increment: receiptLine.newlyProcessedQty },
              lastProcessedReceivedQty: { increment: receiptLine.newlyProcessedQty },
              lastCallbackAt: now,
            },
          })
        }

        const updatedLines = await tx.stockTransferLine.findMany({
          where: { transferId },
          select: {
            qty: true,
            qtyReceived: true,
          },
        })
        const allReceived = updatedLines.every((line) => Number(line.qtyReceived) >= Number(line.qty))
        if (allReceived) {
          await tx.stockTransfer.update({
            where: { id: transferId },
            data: {
              status: 'RECEIVED',
              completedAt: transfer.completedAt ?? now,
            },
          })
        }
      }

      const refreshedLines = await tx.wmsAsnLineMap.findMany({
        where: { asnMapId: asnMap.id },
        select: {
          expectedQty: true,
          lastProcessedReceivedQty: true,
        },
      })
      const asnClosed = refreshedLines.every((line) => Number(line.lastProcessedReceivedQty) >= Number(line.expectedQty))

      await tx.wmsAsnMap.update({
        where: { id: asnMap.id },
        data: {
          status: asnClosed ? 'BOOKED_IN' : 'PARTIALLY_BOOKED_IN',
          lastCallbackAt: now,
          ...(asnClosed ? { closedAt: now } : {}),
        },
      })

      if (actionableLines.length === 0) {
        await tx.wmsAsnLineMap.updateMany({
          where: { asnMapId: asnMap.id },
          data: { lastCallbackAt: now },
        })
      }

      await tx.wmsInboundReceiptEvent.update({
        where: { id: lockedEvent.id },
        data: {
          processedAt: now,
          processingError: null,
        },
      })

      return {
        duplicate: false,
        pending: false,
        productIds: Array.from(touchedProductIds),
      }
    }, STOCK_TX_OPTIONS)

    if (processed.duplicate) {
      return {
        status: 'duplicate',
        eventId: event.id,
        externalAsnId: event.externalAsnId,
      }
    }

    if (processed.pending) {
      const pendingReason = normalizePendingReason(processed.pendingReason ?? `ASN ${event.externalAsnId ?? 'unknown'} is not mapped yet`)
      await markEventPending(event.id, pendingReason)
      return {
        status: 'pending',
        eventId: event.id,
        externalAsnId: event.externalAsnId,
        reason: pendingReason,
      }
    }

    if (processed.productIds.length > 0) {
      try {
        await enqueueStockSync(processed.productIds, 'IMS_CHANGE')
      } catch (error) {
        console.error(error)
      }
    }

    await logActivity({
      entityType: 'SYNC',
      entityId: event.id,
      tag: 'sync',
      action: 'mintsoft_booked_in_processed',
      description: `Processed Mintsoft ASN booked-in webhook ${event.externalAsnId}`,
      metadata: {
        externalAsnId: event.externalAsnId,
        productCount: processed.productIds.length,
      },
      resolveUser: false,
    })

    return {
      status: 'processed',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
      productIds: processed.productIds,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Mintsoft booked-in processing failed'
    await markEventFailed(event.id, message)
    await logActivity({
      entityType: 'SYNC',
      entityId: event.id,
      tag: 'sync',
      action: 'mintsoft_booked_in_failed',
      level: 'ERROR',
      description: `Mintsoft ASN booked-in processing failed: ${message}`,
      metadata: {
        externalAsnId: event.externalAsnId,
      },
      resolveUser: false,
    })
    return {
      status: 'failed',
      eventId: event.id,
      externalAsnId: event.externalAsnId,
      error: message,
    }
  }
}

export async function replayMintsoftBookedInEventsForAsn(externalAsnId: string): Promise<{
  processed: number
  duplicates: number
  pending: number
  failed: number
}> {
  const events = await db.wmsInboundReceiptEvent.findMany({
    where: {
      connector: 'mintsoft',
      externalAsnId,
      processedAt: null,
    },
    orderBy: { receivedAt: 'asc' },
    select: { id: true },
  })

  const counters = {
    processed: 0,
    duplicates: 0,
    pending: 0,
    failed: 0,
  }

  for (const event of events) {
    const result = await processMintsoftBookedInEvent(event.id)
    if (result.status === 'processed') {
      counters.processed += 1
    } else if (result.status === 'duplicate') {
      counters.duplicates += 1
    } else if (result.status === 'pending') {
      counters.pending += 1
    } else {
      counters.failed += 1
    }
  }

  return counters
}
export async function sweepUnprocessedMintsoftBookedInEvents(): Promise<{
  attempted: number
  processed: number
  duplicates: number
  pending: number
  failed: number
}> {
  const now = new Date()
  const scannedEvents = await db.wmsInboundReceiptEvent.findMany({
    where: {
      connector: 'mintsoft',
      processedAt: null,
    },
    orderBy: { receivedAt: 'asc' },
    select: {
      id: true,
      processingError: true,
    },
    take: WEBHOOK_SWEEPER_SCAN_LIMIT,
  })

  const events = scannedEvents
    .filter((event) => {
      const retryState = parseWebhookRetryState(event.processingError)
      if (!retryState) return true
      if (retryState.kind === 'dead') return false
      if (!retryState.nextRetryAt) return true
      const nextRetryAt = new Date(retryState.nextRetryAt)
      return !Number.isFinite(nextRetryAt.getTime()) || nextRetryAt <= now
    })
    .slice(0, WEBHOOK_SWEEPER_MAX_EVENTS_PER_RUN)

  const counters = {
    attempted: events.length,
    processed: 0,
    duplicates: 0,
    pending: 0,
    failed: 0,
  }

  for (const event of events) {
    const result = await processMintsoftBookedInEvent(event.id)
    if (result.status === 'processed') {
      counters.processed += 1
    } else if (result.status === 'duplicate') {
      counters.duplicates += 1
    } else if (result.status === 'pending') {
      counters.pending += 1
    } else {
      counters.failed += 1
    }
  }

  return counters
}
