import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { enqueueStockSync } from '@/lib/shopping'

const STOCK_TX_OPTIONS = { maxWait: 5000, timeout: 20000 }

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

async function markEventFailed(eventId: string, error: string): Promise<void> {
  await db.wmsInboundReceiptEvent.update({
    where: { id: eventId },
    data: {
      processingError: error,
    },
  })
}

async function markEventPending(eventId: string, reason: string): Promise<void> {
  await db.wmsInboundReceiptEvent.update({
    where: { id: eventId },
    data: {
      processingError: reason,
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
          lines: {
            select: {
              id: true,
              sourceType: true,
              sourceLineId: true,
              productId: true,
              sku: true,
              expectedQty: true,
              lastProcessedReceivedQty: true,
            },
          },
        },
      })

      if (!asnMap) {
        return {
          duplicate: false,
          pending: true,
          pendingReason: `ASN ${lockedEvent.externalAsnId} is not mapped yet; waiting for ASN finalization`,
          productIds: [] as string[],
        }
      }

      const actionableLines = asnMap.lines
        .filter((line) => Number(line.expectedQty) > Number(line.lastProcessedReceivedQty))

      const unsupportedLines = actionableLines.filter((line) => line.sourceType !== 'PURCHASE_ORDER_LINE')
      if (unsupportedLines.length > 0) {
        const kinds = Array.from(new Set(unsupportedLines.map((line) => line.sourceType))).join(', ')
        throw new Error(`ASN ${lockedEvent.externalAsnId} contains unsupported line source types: ${kinds}`)
      }

      const purchaseOrderLines = actionableLines.length > 0
        ? await tx.purchaseOrderLine.findMany({
            where: {
              id: {
                in: actionableLines.map((line) => line.sourceLineId),
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

      const purchaseLineById = new Map(purchaseOrderLines.map((line) => [line.id, line]))
      const receiptLinesByPoId = new Map<string, Array<{
        asnLineMapId: string
        poLineId: string
        productId: string
        expectedQty: number
        lastProcessedReceivedQty: number
      }>>()

      for (const line of actionableLines) {
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
          lastProcessedReceivedQty: Number(line.lastProcessedReceivedQty),
        })
        receiptLinesByPoId.set(poLine.poId, entry)
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

          const alreadyReceivedOnPoLine = Math.min(receiptLine.expectedQty, Number(poLine.qtyReceived))
          const alreadyAccountedViaAsn = Math.max(receiptLine.lastProcessedReceivedQty, alreadyReceivedOnPoLine)
          const reconciledManualQty = Math.max(0, alreadyAccountedViaAsn - receiptLine.lastProcessedReceivedQty)
          const qtyReceived = Math.max(0, receiptLine.expectedQty - alreadyAccountedViaAsn)

          return {
            ...receiptLine,
            qtyReceived,
            reconciledManualQty,
          }
        }).filter((receiptLine) => receiptLine.qtyReceived > 0 || receiptLine.reconciledManualQty > 0)

        const createdReceiptLines = reconciledLines.filter((receiptLine) => receiptLine.qtyReceived > 0)
        if (createdReceiptLines.length > 0) {
          await tx.purchaseReceipt.create({
            data: {
              poId,
              reference: formatReceiptReference(lockedEvent.externalAsnId, po.reference),
              notes: `Mintsoft ASN booked-in webhook ${lockedEvent.externalAsnId}`,
              lines: {
                create: createdReceiptLines.map((receiptLine) => ({
                  poLineId: receiptLine.poLineId,
                  qtyReceived: receiptLine.qtyReceived,
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
            await tx.stockMovement.create({
              data: {
                type: 'PURCHASE_RECEIPT',
                productId: poLine.productId,
                toWarehouseId: asnMap.warehouseId,
                qty: receiptLine.qtyReceived,
                note: `Received against ${po.reference} via Mintsoft webhook ${lockedEvent.externalAsnId}`,
                referenceType: 'WmsAsnMap',
                referenceId: asnMap.id,
              },
            })

            await tx.costLayer.create({
              data: {
                productId: poLine.productId,
                warehouseId: asnMap.warehouseId,
                receivedQty: receiptLine.qtyReceived,
                remainingQty: receiptLine.qtyReceived,
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
                quantity: receiptLine.qtyReceived,
                reservedQty: 0,
              },
              update: {
                quantity: { increment: receiptLine.qtyReceived },
              },
            })

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
              qtyAccountedViaReceipt: { increment: receiptLine.qtyReceived + receiptLine.reconciledManualQty },
              lastProcessedReceivedQty: { increment: receiptLine.qtyReceived + receiptLine.reconciledManualQty },
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
      const pendingReason = processed.pendingReason ?? `ASN ${event.externalAsnId ?? 'unknown'} is not mapped yet`
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
