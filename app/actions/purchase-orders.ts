'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PoStatus = 'DRAFT' | 'RFQ_SENT' | 'PO_SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'INVOICED' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CANCELLED'

export type PoLineRow = {
  id: string
  productId: string
  sku: string
  productName: string
  imageUrl: string | null
  description: string | null
  qty: number
  unitCostForeign: number
  unitCostGbp: number
  totalForeign: number
  totalGbp: number
  qtyReceived: number
  purchaseUnitId: string | null
  purchaseUnitName: string | null
  purchaseUnitStockName: string | null
  purchaseUnitQty: number | null
  qtyReturned: number
  grossUnitCostGbp: number // unitCostGbp + landed cost per unit
  qtyToReceive: number  // qty - qtyReceived (still outstanding)
  qtyRemaining: number  // qtyReceived - qtyReturned (net on hand)
  sortOrder: number
}

export type PoRow = {
  id: string
  reference: string
  type: 'GOODS' | 'FREIGHT'
  status: PoStatus
  supplierId: string
  supplierName: string
  currency: string
  fxRateToGbp: number
  subtotalForeign: number
  subtotalGbp: number
  taxRateName: string | null
  taxRatePercent: number | null
  taxForeign: number
  taxGbp: number
  totalForeign: number
  totalGbp: number
  directFreightForeign: number
  directFreightGbp: number
  landedCostMethod: string
  destinationWarehouseId: string | null
  destinationWarehouseName: string | null
  supplierRef: string | null
  expectedDelivery: string | null
  notes: string | null
  internalNotes: string | null
  createdAt: string
  updatedAt: string
  lineCount: number
  // Derived flags for multi-status display
  isInvoiced: boolean
  invoiceCount: number
  isPartiallyReturned: boolean
  isFullyReturned: boolean
}

export type PoReturn = {
  id: string
  reference: string | null
  reason: string | null
  notes: string | null
  returnedAt: string
  lines: {
    id: string
    poLineId: string
    productId: string
    sku: string
    productName: string
    qtyReturned: number
    warehouseId: string | null
  }[]
}

export type PoDetail = PoRow & {
  lines: PoLineRow[]
  receipts: {
    id: string
    reference: string | null
    receivedAt: string
    notes: string | null
    lines: {
      id: string
      poLineId: string
      productId: string
      sku: string
      productName: string
      qtyReceived: number
      warehouseId: string | null
      warehouseName: string | null
    }[]
  }[]
  returns: PoReturn[]
  invoices: InvoiceRow[]
  freightCostLines: { id: string; description: string; amountForeign: number; amountGbp: number; vatable: boolean; distributionMethod: string }[]
  linkedFreightPos: {
    linkId: string
    method: string
    freightPo: {
      id: string
      reference: string
      supplierName: string
      totalForeign: number
      totalGbp: number
      costLines: { description: string; amountGbp: number; distributionMethod: string }[]
    }
  }[]
  totalLandedCostGbp: number
  linkedPrimaryPos: { id: string; reference: string; supplierName: string; totalGbp: number }[]
}

export type PoLineInput = {
  productId: string
  sku: string
  productName: string
  description?: string
  qty: number // stock units
  purchaseUnitId?: string
  purchaseUnitQty?: number // qty in purchase units
  unitCostForeign: number // cost per stock unit (converted from purchase unit cost)
  sortOrder?: number
}

export type CreatePoInput = {
  supplierId: string
  currency: string
  fxRateToGbp: number
  destinationWarehouseId?: string
  supplierRef?: string
  expectedDelivery?: string
  notes?: string
  internalNotes?: string
  pricesIncludeVat: boolean
  taxRateId?: string
  taxRateName?: string
  taxRateValue?: number // e.g. 0.20 for 20%
  additionalCosts?: { description: string; amountForeign: number; vatable: boolean; distributionMethod: string }[]
  lines: PoLineInput[]
}

export type ReceiptLineInput = {
  poLineId: string
  qtyReceived: number
  warehouseId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeReference(): Promise<string> {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  const { getNumberingFormats } = await import('./company')
  const { po_prefix } = await getNumberingFormats()
  return `${po_prefix}${ymd}-${rand}`
}

function safeFxRate(rate: number): number {
  return rate > 0 ? rate : 1
}

function calcLineTotals(unitCostForeign: number, qty: number, fxRate: number) {
  const rate = safeFxRate(fxRate)
  const totalForeign = Math.round(unitCostForeign * qty * 10000) / 10000
  const unitCostGbp = Math.round((unitCostForeign / rate) * 1000000) / 1000000
  const totalGbp = Math.round((totalForeign / rate) * 10000) / 10000
  return { unitCostGbp, totalForeign, totalGbp }
}

const PO_SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
  supplierId: true,
  currency: true,
  fxRateToGbp: true,
  subtotalForeign: true,
  subtotalGbp: true,
  taxRateName: true,
  taxRatePercent: true,
  taxForeign: true,
  taxGbp: true,
  totalForeign: true,
  totalGbp: true,
  directFreightForeign: true,
  directFreightGbp: true,
  landedCostMethod: true,
  destinationWarehouseId: true,
  supplierRef: true,
  expectedDelivery: true,
  notes: true,
  internalNotes: true,
  createdAt: true,
  updatedAt: true,
  supplier: { select: { id: true, name: true } },
  destinationWarehouse: { select: { id: true, name: true } },
  lines: {
    select: {
      id: true,
      productId: true,
      description: true,
      qty: true,
      unitCostForeign: true,
      unitCostGbp: true,
      totalForeign: true,
      totalGbp: true,
      purchaseUnitId: true,
      purchaseUnitQty: true,
      purchaseUnit: { select: { name: true, abbreviation: true, conversionFactor: true, stockUnitName: true } },
      qtyReceived: true,
      qtyReturned: true,
      sortOrder: true,
      product: { select: { sku: true, name: true, imageUrl: true } },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  _count: { select: { invoices: true, returns: true } },
} as const

function mapPoRow(po: {
  id: string
  reference: string
  type: string
  status: string
  supplierId: string
  currency: string
  fxRateToGbp: unknown
  subtotalForeign: unknown
  subtotalGbp: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  taxForeign: unknown
  taxGbp: unknown
  totalForeign: unknown
  totalGbp: unknown
  directFreightForeign: unknown
  directFreightGbp: unknown
  landedCostMethod: string
  destinationWarehouseId: string | null
  supplierRef: string | null
  expectedDelivery: Date | null
  notes: string | null
  internalNotes: string | null
  createdAt: Date
  updatedAt: Date
  supplier: { name: string }
  destinationWarehouse: { name: string } | null
  lines: { id: string; qtyReceived: unknown; qtyReturned: unknown }[]
  _count: { invoices: number; returns: number }
}): PoRow {
  const anyReturned = po.lines.some((l) => Number(l.qtyReturned) > 0)
  const allReturned = po.lines.length > 0 && po.lines.every(
    (l) => Number(l.qtyReceived) > 0 && Number(l.qtyReturned) >= Number(l.qtyReceived),
  )
  return {
    id: po.id,
    reference: po.reference,
    type: po.type as 'GOODS' | 'FREIGHT',
    status: po.status as PoStatus,
    supplierId: po.supplierId,
    supplierName: po.supplier.name,
    currency: po.currency,
    fxRateToGbp: Number(po.fxRateToGbp),
    subtotalForeign: Number(po.subtotalForeign),
    subtotalGbp: Number(po.subtotalGbp),
    taxRateName: po.taxRateName,
    taxRatePercent: po.taxRatePercent != null ? Number(po.taxRatePercent) : null,
    taxForeign: Number(po.taxForeign),
    taxGbp: Number(po.taxGbp),
    totalForeign: Number(po.totalForeign),
    totalGbp: Number(po.totalGbp),
    directFreightForeign: Number(po.directFreightForeign),
    directFreightGbp: Number(po.directFreightGbp),
    landedCostMethod: po.landedCostMethod as string,
    destinationWarehouseId: po.destinationWarehouseId,
    destinationWarehouseName: po.destinationWarehouse?.name ?? null,
    supplierRef: po.supplierRef,
    expectedDelivery: po.expectedDelivery?.toISOString() ?? null,
    notes: po.notes,
    internalNotes: po.internalNotes,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
    lineCount: po.lines.length,
    isInvoiced: po._count.invoices > 0,
    invoiceCount: po._count.invoices,
    isPartiallyReturned: anyReturned && !allReturned,
    isFullyReturned: allReturned,
  }
}

function mapLine(l: {
  id: string
  productId: string
  description: string | null
  qty: unknown
  unitCostForeign: unknown
  unitCostGbp: unknown
  totalForeign: unknown
  totalGbp: unknown
  purchaseUnitId: string | null
  purchaseUnitQty: unknown
  purchaseUnit: { name: string; abbreviation: string; conversionFactor: unknown; stockUnitName: string } | null
  qtyReceived: unknown
  qtyReturned: unknown
  sortOrder: number
  product: { sku: string; name: string; imageUrl: string | null }
}): PoLineRow {
  const qty = Number(l.qty)
  const qtyReceived = Number(l.qtyReceived)
  const qtyReturned = Number(l.qtyReturned)
  return {
    id: l.id,
    productId: l.productId,
    sku: l.product.sku,
    productName: l.product.name,
    imageUrl: l.product.imageUrl,
    description: l.description,
    qty,
    unitCostForeign: Number(l.unitCostForeign),
    unitCostGbp: Number(l.unitCostGbp),
    totalForeign: Number(l.totalForeign),
    totalGbp: Number(l.totalGbp),
    purchaseUnitId: l.purchaseUnitId,
    purchaseUnitName: l.purchaseUnit ? l.purchaseUnit.abbreviation : null,
    purchaseUnitStockName: l.purchaseUnit?.stockUnitName ?? null,
    purchaseUnitQty: l.purchaseUnitQty != null ? Number(l.purchaseUnitQty) : null,
    grossUnitCostGbp: Number(l.unitCostGbp), // overridden by getPurchaseOrder with actual landed cost
    qtyReceived,
    qtyReturned,
    qtyToReceive: Math.max(0, qty - qtyReceived),
    qtyRemaining: Math.max(0, qtyReceived - qtyReturned),
    sortOrder: l.sortOrder,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPurchaseOrders(limit = 200): Promise<PoRow[]> {
  await requireAuth()
  const pos = await db.purchaseOrder.findMany({
    select: PO_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return pos.map(mapPoRow)
}

export async function getPurchaseOrder(id: string): Promise<PoDetail | null> {
  await requireAuth()
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: {
      ...PO_SELECT,
      receipts: {
        select: {
          id: true,
          reference: true,
          receivedAt: true,
          notes: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              qtyReceived: true,
              warehouseId: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true } },
                },
              },
            },
          },
        },
        orderBy: { receivedAt: 'desc' },
      },
      returns: {
        select: {
          id: true,
          reference: true,
          reason: true,
          notes: true,
          returnedAt: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              qtyReturned: true,
              warehouseId: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true } },
                },
              },
            },
          },
        },
        orderBy: { returnedAt: 'desc' },
      },
      invoices: {
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          dueDate: true,
          subtotalForeign: true,
          subtotalGbp: true,
          taxForeign: true,
          taxGbp: true,
          totalForeign: true,
          totalGbp: true,
          notes: true,
          supplierInvoiceUrl: true,
          accountingInvoiceId: true,
          createdAt: true,
          lines: {
            select: {
              id: true,
              poLineId: true,
              qtyBilled: true,
              unitCostForeign: true,
              totalForeign: true,
              totalGbp: true,
              poLine: {
                select: {
                  productId: true,
                  product: { select: { sku: true, name: true, imageUrl: true } },
                },
              },
            },
          },
        },
        orderBy: { invoiceDate: 'desc' },
      },
      freightCostLines: {
        select: {
          id: true,
          description: true,
          amountForeign: true,
          amountGbp: true,
          vatable: true,
          distributionMethod: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!po) return null

  // Fetch linked freight POs for landed cost calculation
  const freightLinks = await getLinkedFreightPos(id)
  let totalLandedCostGbp = 0
  for (const fl of freightLinks) {
    totalLandedCostGbp += fl.freightPo.totalGbp
  }
  // Also add direct freight from the PO itself
  totalLandedCostGbp += Number(po.directFreightGbp)

  // Calculate landed cost per line (distribute by value for now)
  const poSubtotalGbp = Number(po.subtotalGbp)
  const mappedLines = po.lines.map(mapLine).map((line) => {
    let landedPerUnit = 0
    if (totalLandedCostGbp > 0 && poSubtotalGbp > 0 && line.qty > 0) {
      // BY_VALUE distribution: proportional to line value
      const lineShare = line.totalGbp / poSubtotalGbp
      const landedForLine = totalLandedCostGbp * lineShare
      landedPerUnit = landedForLine / line.qty
    }
    return { ...line, grossUnitCostGbp: line.unitCostGbp + landedPerUnit }
  })

  const row = mapPoRow(po)
  return {
    ...row,
    lines: mappedLines,
    receipts: po.receipts.map((r) => ({
      id: r.id,
      reference: r.reference,
      receivedAt: r.receivedAt.toISOString(),
      notes: r.notes,
      lines: r.lines.map((rl) => ({
        id: rl.id,
        poLineId: rl.poLineId,
        productId: rl.poLine.productId,
        sku: rl.poLine.product.sku,
        productName: rl.poLine.product.name,
        qtyReceived: Number(rl.qtyReceived),
        warehouseId: rl.warehouseId,
        warehouseName: null,
      })),
    })),
    returns: po.returns.map((r) => ({
      id: r.id,
      reference: r.reference,
      reason: r.reason,
      notes: r.notes,
      returnedAt: r.returnedAt.toISOString(),
      lines: r.lines.map((rl) => ({
        id: rl.id,
        poLineId: rl.poLineId,
        productId: rl.poLine.productId,
        sku: rl.poLine.product.sku,
        productName: rl.poLine.product.name,
        qtyReturned: Number(rl.qtyReturned),
        warehouseId: rl.warehouseId,
      })),
    })),
    invoices: po.invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate.toISOString(),
      dueDate: inv.dueDate?.toISOString() ?? null,
      subtotalForeign: Number(inv.subtotalForeign),
      subtotalGbp: Number(inv.subtotalGbp),
      taxForeign: Number(inv.taxForeign),
      taxGbp: Number(inv.taxGbp),
      totalForeign: Number(inv.totalForeign),
      totalGbp: Number(inv.totalGbp),
      notes: inv.notes,
      supplierInvoiceUrl: inv.supplierInvoiceUrl,
      accountingInvoiceId: inv.accountingInvoiceId ?? null,
      createdAt: inv.createdAt.toISOString(),
      lines: inv.lines.map((il) => ({
        id: il.id,
        poLineId: il.poLineId,
        productId: il.poLine.productId,
        sku: il.poLine.product.sku,
        productName: il.poLine.product.name,
        qtyBilled: Number(il.qtyBilled),
        unitCostForeign: Number(il.unitCostForeign),
        totalForeign: Number(il.totalForeign),
        totalGbp: Number(il.totalGbp),
      })),
    })),
    freightCostLines: (po.freightCostLines ?? []).map((cl) => ({
      id: cl.id,
      description: cl.description,
      amountForeign: Number(cl.amountForeign),
      amountGbp: Number(cl.amountGbp),
      vatable: cl.vatable,
      distributionMethod: cl.distributionMethod as string,
    })),
    linkedFreightPos: freightLinks.map((fl) => ({
      linkId: fl.linkId,
      method: fl.method,
      freightPo: {
        id: fl.freightPo.id,
        reference: fl.freightPo.reference,
        supplierName: fl.freightPo.supplierName,
        totalForeign: fl.freightPo.totalForeign,
        totalGbp: fl.freightPo.totalGbp,
        costLines: fl.freightPo.costLines.map((cl) => ({
          description: cl.description,
          amountGbp: cl.amountGbp,
          distributionMethod: cl.distributionMethod,
        })),
      },
    })),
    totalLandedCostGbp,
    linkedPrimaryPos: await (async () => {
      // For FREIGHT POs: show which primary POs this is linked to
      const primaryLinks = await db.landedCostLink.findMany({
        where: { freightPoId: id },
        select: {
          primaryPO: { select: { id: true, reference: true, totalGbp: true, supplier: { select: { name: true } } } },
        },
      })
      return primaryLinks.map((l) => ({
        id: l.primaryPO.id,
        reference: l.primaryPO.reference,
        supplierName: l.primaryPO.supplier.name,
        totalGbp: Number(l.primaryPO.totalGbp),
      }))
    })(),
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createPurchaseOrder(input: CreatePoInput): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requireAuth()
    if (!input.lines.length) return { success: false, error: 'At least one line is required' }
    // Validate line inputs
    for (const l of input.lines) {
      if (l.qty <= 0) return { success: false, error: `Invalid qty for ${l.sku}` }
      if (l.unitCostForeign < 0) return { success: false, error: `Negative cost for ${l.sku}` }
    }

    const fxRate = safeFxRate(input.fxRateToGbp || 1)
    const vatRate = input.taxRateValue ?? 0
    const inclVat = input.pricesIncludeVat && vatRate > 0
    let subtotalForeign = 0
    let subtotalGbp = 0
    let totalTaxForeign = 0
    let totalTaxGbp = 0

    const lineData = input.lines.map((l, i) => {
      // If prices include VAT, extract net; otherwise use as-is
      const netUnitForeign = inclVat ? l.unitCostForeign / (1 + vatRate) : l.unitCostForeign
      const { unitCostGbp, totalForeign, totalGbp } = calcLineTotals(netUnitForeign, l.qty, fxRate)
      const lineTaxForeign = inclVat
        ? Math.round((l.unitCostForeign * l.qty - totalForeign) * 10000) / 10000
        : Math.round(totalForeign * vatRate * 10000) / 10000
      const lineTaxGbp = Math.round((lineTaxForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalGbp += totalGbp
      totalTaxForeign += lineTaxForeign
      totalTaxGbp += lineTaxGbp
      return {
        productId: l.productId,
        description: l.description || null,
        qty: l.qty,
        purchaseUnitId: l.purchaseUnitId || null,
        purchaseUnitQty: l.purchaseUnitQty ?? null,
        unitCostForeign: netUnitForeign,
        unitCostGbp,
        taxRateId: input.taxRateId || null,
        taxForeign: lineTaxForeign,
        taxGbp: lineTaxGbp,
        totalForeign,
        totalGbp,
        sortOrder: l.sortOrder ?? i,
      }
    })

    // Additional costs (shipping, fees, etc.) → directFreight fields
    let directFreightForeign = 0
    let directFreightGbp = 0
    let additionalCostVatForeign = 0
    let additionalCostVatGbp = 0
    if (input.additionalCosts?.length) {
      for (const ac of input.additionalCosts) {
        directFreightForeign += ac.amountForeign
        if (ac.vatable && vatRate > 0) {
          additionalCostVatForeign += Math.round(ac.amountForeign * vatRate * 10000) / 10000
        }
      }
      directFreightGbp = Math.round((directFreightForeign / fxRate) * 10000) / 10000
      additionalCostVatGbp = Math.round((additionalCostVatForeign / fxRate) * 10000) / 10000
      totalTaxForeign += additionalCostVatForeign
      totalTaxGbp += additionalCostVatGbp
    }

    // Use the first additional cost's distribution method, or BY_VALUE as default
    const firstMethod = input.additionalCosts?.find((ac) => ac.amountForeign > 0)?.distributionMethod
    const lcMethod = (['BY_VALUE', 'BY_WEIGHT', 'BY_QUANTITY', 'EQUAL_SPLIT'].includes(firstMethod ?? '')
      ? firstMethod!
      : 'BY_VALUE') as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT'

    const grandTotalForeign = subtotalForeign + totalTaxForeign + directFreightForeign
    const grandTotalGbp = subtotalGbp + totalTaxGbp + directFreightGbp

    const poReference = await makeReference()
    const po = await db.purchaseOrder.create({
      data: {
        reference: poReference,
        type: 'GOODS',
        supplierId: input.supplierId,
        currency: input.currency,
        fxRateToGbp: fxRate,
        subtotalForeign,
        subtotalGbp,
        taxRateName: input.taxRateName || null,
        taxRatePercent: vatRate > 0 ? vatRate : null,
        taxForeign: totalTaxForeign,
        taxGbp: totalTaxGbp,
        totalForeign: grandTotalForeign,
        totalGbp: grandTotalGbp,
        directFreightForeign,
        directFreightGbp,
        landedCostMethod: lcMethod,
        destinationWarehouseId: input.destinationWarehouseId || null,
        supplierRef: input.supplierRef || null,
        expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null,
        notes: input.notes || null,
        internalNotes: input.internalNotes || null,
        lines: { create: lineData },
      },
      select: PO_SELECT,
    })

    // Update SupplierProduct last prices (in supplier's currency, net of VAT)
    for (const ld of lineData) {
      await db.supplierProduct.upsert({
        where: { supplierId_productId: { supplierId: input.supplierId, productId: ld.productId } },
        create: {
          supplierId: input.supplierId,
          productId: ld.productId,
          supplierSku: null,
          lastUnitCost: ld.unitCostForeign,
          currency: input.currency,
        },
        update: {
          lastUnitCost: ld.unitCostForeign,
          currency: input.currency,
        },
      })
    }

    revalidatePath('/purchase-orders')
    const mapped = mapPoRow(po)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: mapped.id,
      action: 'created',
      tag: 'purchase',
      level: 'INFO',
      description: `Created PO ${mapped.reference} for ${mapped.supplierName}`,
      metadata: { reference: mapped.reference, supplierId: input.supplierId, currency: input.currency, lineCount: input.lines.length },
    })
    return { success: true, po: mapped }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: null,
      action: 'created',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create PO: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function updatePurchaseOrder(
  id: string,
  input: Partial<CreatePoInput>,
): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requireAuth()
    const existing = await db.purchaseOrder.findUnique({
      where: { id },
      select: { status: true, fxRateToGbp: true },
    })
    if (!existing) return { success: false, error: 'PO not found' }
    if (existing.status !== 'DRAFT') return { success: false, error: 'Only DRAFT POs can be edited' }

    const fxRate = input.fxRateToGbp ?? Number(existing.fxRateToGbp)
    let subtotalForeign: number | undefined
    let subtotalGbp: number | undefined

    const updates: Record<string, unknown> = {
      ...(input.supplierId !== undefined && { supplierId: input.supplierId }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.fxRateToGbp !== undefined && { fxRateToGbp: input.fxRateToGbp }),
      ...(input.destinationWarehouseId !== undefined && { destinationWarehouseId: input.destinationWarehouseId || null }),
      ...(input.supplierRef !== undefined && { supplierRef: input.supplierRef || null }),
      ...(input.expectedDelivery !== undefined && { expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null }),
      ...(input.notes !== undefined && { notes: input.notes || null }),
      ...(input.internalNotes !== undefined && { internalNotes: input.internalNotes || null }),
    }

    if (input.lines) {
      // Delete existing lines and recreate
      await db.purchaseOrderLine.deleteMany({ where: { poId: id } })
      subtotalForeign = 0
      subtotalGbp = 0
      const lineData = input.lines.map((l, i) => {
        const { unitCostGbp, totalForeign, totalGbp } = calcLineTotals(l.unitCostForeign, l.qty, fxRate)
        subtotalForeign! += totalForeign
        subtotalGbp! += totalGbp
        return {
          poId: id,
          productId: l.productId,
          description: l.description || null,
          qty: l.qty,
          unitCostForeign: l.unitCostForeign,
          unitCostGbp,
          taxRateId: null,
          taxForeign: 0,
          taxGbp: 0,
          totalForeign,
          totalGbp,
          sortOrder: l.sortOrder ?? i,
        }
      })
      await db.purchaseOrderLine.createMany({ data: lineData })
      updates.subtotalForeign = subtotalForeign
      updates.subtotalGbp = subtotalGbp
      updates.totalForeign = subtotalForeign
      updates.totalGbp = subtotalGbp
    }

    const po = await db.purchaseOrder.update({
      where: { id },
      data: updates,
      select: PO_SELECT,
    })

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    const mapped = mapPoRow(po)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated PO ${mapped.reference}`,
      metadata: { reference: mapped.reference },
    })
    return { success: true, po: mapped }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to update PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function advancePoStatus(
  id: string,
  targetStatus: 'PO_SENT' | 'RFQ_SENT',
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const existing = await db.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
    if (!existing) return { success: false, error: 'PO not found' }

    const now = new Date()
    const data: Record<string, unknown> = { status: targetStatus }
    if (targetStatus === 'RFQ_SENT') data.rfqSentAt = now
    if (targetStatus === 'PO_SENT') data.poSentAt = now

    await db.purchaseOrder.update({ where: { id }, data })
    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'purchase',
      level: 'INFO',
      description: `Advanced PO ${existing.reference} to ${targetStatus}`,
      metadata: { reference: existing.reference, previousStatus: existing.status, newStatus: targetStatus },
    })

    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to advance PO ${id} status: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function receivePurchaseOrder(
  id: string,
  receiptLines: ReceiptLineInput[],
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        fxRateToGbp: true,
        lines: {
          select: {
            id: true,
            productId: true,
            qty: true,
            qtyReceived: true,
            unitCostGbp: true,
            landedUnitCostGbp: true,
          },
        },
      },
    })
    if (!po) return { success: false, error: 'PO not found' }
    if (!['PO_SENT', 'PARTIALLY_RECEIVED', 'RFQ_SENT'].includes(po.status)) {
      return { success: false, error: 'PO cannot be received in its current status' }
    }

    const linesWithQty = receiptLines.filter((rl) => rl.qtyReceived > 0)
    if (!linesWithQty.length) return { success: false, error: 'No quantities to receive' }

    // Validate: can't receive more than outstanding qty
    for (const rl of linesWithQty) {
      if (!rl.warehouseId) return { success: false, error: 'Warehouse is required for each line' }
      const poLine = po.lines.find((l) => l.id === rl.poLineId)
      if (!poLine) return { success: false, error: 'Invalid PO line' }
      const outstanding = Number(poLine.qty) - Number(poLine.qtyReceived)
      if (rl.qtyReceived > outstanding) {
        return { success: false, error: `Cannot receive more than outstanding qty (${outstanding})` }
      }
    }

    // Create receipt
    const receiptRef = `RCP-${po.reference}-${Date.now().toString(36).toUpperCase()}`
    await db.purchaseReceipt.create({
      data: {
        poId: id,
        reference: receiptRef,
        notes: notes || null,
        lines: {
          create: linesWithQty.map((rl) => ({
            poLineId: rl.poLineId,
            qtyReceived: rl.qtyReceived,
            warehouseId: rl.warehouseId || null,
          })),
        },
      },
    })

    // Process each receipt line: update stock, create movement + cost layer
    for (const rl of linesWithQty) {
      const poLine = po.lines.find((l) => l.id === rl.poLineId)
      if (!poLine) continue

      const unitCostGbp = Number(poLine.landedUnitCostGbp) > 0
        ? Number(poLine.landedUnitCostGbp)
        : Number(poLine.unitCostGbp)

      // Create stock movement
      await db.stockMovement.create({
        data: {
          type: 'PURCHASE_RECEIPT',
          productId: poLine.productId,
          toWarehouseId: rl.warehouseId,
          qty: rl.qtyReceived,
          note: `Received against ${po.reference}`,
          referenceType: 'PurchaseOrder',
          referenceId: id,
        },
      })

      // Create FIFO cost layer
      await db.costLayer.create({
        data: {
          productId: poLine.productId,
          warehouseId: rl.warehouseId,
          receivedQty: rl.qtyReceived,
          remainingQty: rl.qtyReceived,
          unitCostGbp,
          poLineId: poLine.id,
          isOpeningStock: false,
        },
      })

      // Update stock level
      await db.stockLevel.upsert({
        where: {
          productId_warehouseId: {
            productId: poLine.productId,
            warehouseId: rl.warehouseId,
          },
        },
        create: {
          productId: poLine.productId,
          warehouseId: rl.warehouseId,
          quantity: rl.qtyReceived,
          reservedQty: 0,
        },
        update: {
          quantity: { increment: rl.qtyReceived },
        },
      })

      // Update PO line qtyReceived
      await db.purchaseOrderLine.update({
        where: { id: rl.poLineId },
        data: { qtyReceived: { increment: rl.qtyReceived } },
      })
    }

    // Determine new PO status
    const updatedLines = await db.purchaseOrderLine.findMany({
      where: { poId: id },
      select: { qty: true, qtyReceived: true },
    })
    const allReceived = updatedLines.every((l) => Number(l.qtyReceived) >= Number(l.qty))

    const newStatus = allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED'
    await db.purchaseOrder.update({
      where: { id },
      data: {
        status: newStatus,
        ...(allReceived && { receivedAt: new Date() }),
      },
    })

    // Auto-mark linked freight POs as received when all their primary POs are received
    if (allReceived) {
      const freightLinks = await db.landedCostLink.findMany({
        where: { primaryPoId: id },
        select: { freightPoId: true },
      })
      for (const fl of freightLinks) {
        const allLinks = await db.landedCostLink.findMany({
          where: { freightPoId: fl.freightPoId },
          select: { primaryPO: { select: { status: true } } },
        })
        if (allLinks.every((l) => l.primaryPO.status === 'RECEIVED')) {
          await db.purchaseOrder.update({
            where: { id: fl.freightPoId },
            data: { status: 'RECEIVED', receivedAt: new Date() },
          })
          revalidatePath(`/purchase-orders/${fl.freightPoId}`)
        }
      }
    }

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'received',
      tag: 'purchase',
      level: 'INFO',
      description: `Received PO ${po.reference} (${linesWithQty.length} lines)`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, newStatus },
    })

    // Log stock movement for the receipt
    const receiptWarehouseNames = await db.warehouse.findMany({
      where: { id: { in: linesWithQty.map((rl) => rl.warehouseId) } },
      select: { id: true, name: true },
    })
    const whNameMap = Object.fromEntries(receiptWarehouseNames.map((w) => [w.id, w.name]))
    const warehouseNamesList = [...new Set(linesWithQty.map((rl) => whNameMap[rl.warehouseId] ?? rl.warehouseId))].join(', ')
    logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'purchase_receipt',
      tag: 'stock',
      level: 'INFO',
      description: `Received ${linesWithQty.length} lines for PO ${po.reference} into ${warehouseNamesList}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length },
    })

    // Queue accounting stock receipt journal: DR Inventory / CR Stock-in-Transit
    try {
      const settings = await getAccountingSettings()
      const totalReceiptValue = linesWithQty.reduce((sum, rl) => {
        const poLine = po.lines.find(l => l.id === rl.poLineId)
        if (!poLine) return sum
        const unitCost = Number(poLine.landedUnitCostGbp) > 0 ? Number(poLine.landedUnitCostGbp) : Number(poLine.unitCostGbp)
        return sum + rl.qtyReceived * unitCost
      }, 0)
      if (totalReceiptValue > 0) {
        await queueAccountingSync({
          type: 'STOCK_RECEIPT',
          referenceType: 'PurchaseOrder',
          referenceId: id,
          payload: {
            date: new Date().toISOString().slice(0, 10),
            reference: `Receipt: ${po.reference}`,
            narration: `Stock receipt for PO ${po.reference} — ${linesWithQty.length} lines into ${warehouseNamesList}`,
            lines: [
              { accountCode: settings.inventoryAccount, description: `Stock receipt: ${po.reference}`, debit: Math.round(totalReceiptValue * 100) / 100 },
              { accountCode: settings.transitAccount, description: `Stock receipt: ${po.reference}`, credit: Math.round(totalReceiptValue * 100) / 100 },
            ],
          },
        })
      }
    } catch { /* Accounting queue errors should never block the main flow */ }

    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'received',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to receive PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function cancelPurchaseOrder(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const existing = await db.purchaseOrder.findUnique({ where: { id }, select: { status: true, reference: true } })
    if (!existing) return { success: false, error: 'PO not found' }
    if (existing.status !== 'DRAFT') return { success: false, error: 'Only DRAFT POs can be cancelled' }

    await db.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'INFO',
      description: `Cancelled PO ${existing.reference}`,
      metadata: { reference: existing.reference },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'cancelled',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to cancel PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function getSupplierLastPrices(
  supplierId: string,
): Promise<Record<string, { lastUnitCost: number; currency: string; supplierSku: string | null }>> {
  await requireAuth()
  const rows = await db.supplierProduct.findMany({
    where: { supplierId },
    select: { productId: true, lastUnitCost: true, currency: true, supplierSku: true },
  })
  const result: Record<string, { lastUnitCost: number; currency: string; supplierSku: string | null }> = {}
  for (const r of rows) {
    result[r.productId] = {
      lastUnitCost: Number(r.lastUnitCost),
      currency: r.currency,
      supplierSku: r.supplierSku,
    }
  }
  return result
}

export type ReturnLineInput = {
  poLineId: string
  qtyReturned: number
  warehouseId: string
}

export async function returnPurchaseOrder(
  id: string,
  returnLines: ReturnLineInput[],
  reason: string,
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      select: {
        id: true,
        reference: true,
        status: true,
        lines: {
          select: {
            id: true,
            productId: true,
            qtyReceived: true,
            qtyReturned: true,
          },
        },
      },
    })
    if (!po) return { success: false, error: 'PO not found' }

    const returnable: PoStatus[] = ['PO_SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED']
    if (!returnable.includes(po.status as PoStatus)) {
      return { success: false, error: 'Cannot return from a PO in this status' }
    }

    const linesWithQty = returnLines.filter((rl) => rl.qtyReturned > 0)
    if (!linesWithQty.length) return { success: false, error: 'Enter at least one quantity to return' }

    // Validate: can't return more than net received (received - already returned)
    for (const rl of linesWithQty) {
      const poLine = po.lines.find((l) => l.id === rl.poLineId)
      if (!poLine) return { success: false, error: 'Invalid PO line' }
      const netReceived = Number(poLine.qtyReceived) - Number(poLine.qtyReturned)
      if (rl.qtyReturned > netReceived) {
        return { success: false, error: `Cannot return more than net received quantity` }
      }
      // Check stock level won't go negative
      const stockLevel = await db.stockLevel.findUnique({
        where: { productId_warehouseId: { productId: poLine.productId, warehouseId: rl.warehouseId } },
      })
      if (stockLevel && Number(stockLevel.quantity) < rl.qtyReturned) {
        return { success: false, error: `Insufficient stock to return (only ${Number(stockLevel.quantity)} available)` }
      }
    }

    const returnRef = `RTN-${po.reference}-${Date.now().toString(36).toUpperCase()}`
    await db.purchaseReturn.create({
      data: {
        poId: id,
        reference: returnRef,
        reason: reason || null,
        notes: notes || null,
        lines: {
          create: linesWithQty.map((rl) => ({
            poLineId: rl.poLineId,
            qtyReturned: rl.qtyReturned,
            warehouseId: rl.warehouseId || null,
          })),
        },
      },
    })

    // Process each line: decrement stock, create stock movement, update qtyReturned
    for (const rl of linesWithQty) {
      const poLine = po.lines.find((l) => l.id === rl.poLineId)!

      // Stock movement: stock leaves our warehouse (fromWarehouseId set, toWarehouseId null)
      await db.stockMovement.create({
        data: {
          type: 'ADJUSTMENT',
          productId: poLine.productId,
          fromWarehouseId: rl.warehouseId,
          qty: rl.qtyReturned,
          note: `Return to supplier against ${po.reference}${reason ? ` — ${reason}` : ''}`,
          referenceType: 'PurchaseReturn',
          referenceId: id,
        },
      })

      // Decrement stock level
      await db.stockLevel.updateMany({
        where: { productId: poLine.productId, warehouseId: rl.warehouseId },
        data: { quantity: { decrement: rl.qtyReturned } },
      })

      // Update PO line qtyReturned
      await db.purchaseOrderLine.update({
        where: { id: rl.poLineId },
        data: { qtyReturned: { increment: rl.qtyReturned } },
      })
    }

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${id}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'returned',
      tag: 'purchase',
      level: 'INFO',
      description: `Created return for PO ${po.reference}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, reason },
    })

    // Log stock movement for the return
    logActivity({
      entityType: 'STOCK_ADJUSTMENT',
      entityId: id,
      action: 'purchase_return',
      tag: 'stock',
      level: 'INFO',
      description: `Returned stock for PO ${po.reference}`,
      metadata: { reference: po.reference, lineCount: linesWithQty.length, reason },
    })

    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      action: 'returned',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to return PO ${id}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Billing / Invoicing
// ---------------------------------------------------------------------------

export type InvoiceLineInput = {
  poLineId: string
  qtyBilled: number
  unitCostForeign: number
}

export type CreateInvoiceInput = {
  invoiceNumber?: string
  invoiceDate: string
  dueDate?: string
  notes?: string
  supplierInvoiceUrl?: string
  lines: InvoiceLineInput[]
}

export type InvoiceRow = {
  id: string
  invoiceNumber: string | null
  invoiceDate: string
  dueDate: string | null
  subtotalForeign: number
  subtotalGbp: number
  taxForeign: number
  taxGbp: number
  totalForeign: number
  totalGbp: number
  notes: string | null
  supplierInvoiceUrl: string | null
  accountingInvoiceId: string | null
  createdAt: string
  lines: {
    id: string
    poLineId: string
    productId: string
    sku: string
    productName: string
    qtyBilled: number
    unitCostForeign: number
    totalForeign: number
    totalGbp: number
  }[]
}

export async function createInvoice(
  poId: string,
  input: CreateInvoiceInput,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const po = await db.purchaseOrder.findUnique({
      where: { id: poId },
      select: {
        id: true,
        reference: true,
        status: true,
        fxRateToGbp: true,
        taxForeign: true,
        subtotalForeign: true,
      },
    })
    if (!po) return { success: false, error: 'PO not found' }

    const linesWithQty = input.lines.filter((l) => l.qtyBilled > 0)
    if (!linesWithQty.length) return { success: false, error: 'Select at least one line to bill' }

    const fxRate = Number(po.fxRateToGbp)
    let subtotalForeign = 0
    let subtotalGbp = 0

    const lineData = linesWithQty.map((l) => {
      const totalForeign = Math.round(l.qtyBilled * l.unitCostForeign * 10000) / 10000
      const totalGbp = Math.round((totalForeign / fxRate) * 10000) / 10000
      subtotalForeign += totalForeign
      subtotalGbp += totalGbp
      return {
        poLineId: l.poLineId,
        qtyBilled: l.qtyBilled,
        unitCostForeign: l.unitCostForeign,
        totalForeign,
        totalGbp,
      }
    })

    // Calculate tax proportion (same ratio as PO)
    const poSubtotal = Number(po.subtotalForeign)
    const poTax = Number(po.taxForeign)
    const taxRate = poSubtotal > 0 ? poTax / poSubtotal : 0
    const taxForeign = Math.round(subtotalForeign * taxRate * 10000) / 10000
    const taxGbp = Math.round((taxForeign / fxRate) * 10000) / 10000

    const totalForeign = subtotalForeign + taxForeign
    const totalGbp = subtotalGbp + taxGbp

    await db.purchaseInvoice.create({
      data: {
        poId,
        invoiceNumber: input.invoiceNumber || null,
        invoiceDate: new Date(input.invoiceDate),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        subtotalForeign,
        subtotalGbp,
        taxForeign,
        taxGbp,
        totalForeign,
        totalGbp,
        fxRateToGbp: fxRate,
        notes: input.notes || null,
        supplierInvoiceUrl: input.supplierInvoiceUrl || null,
        lines: { create: lineData },
      },
    })

    // Mark invoicedAt (don't change primary status — it's shown as a secondary badge)
    await db.purchaseOrder.update({
      where: { id: poId },
      data: { invoicedAt: new Date() },
    })

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${poId}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      action: 'invoiced',
      tag: 'purchase',
      level: 'INFO',
      description: `Created invoice for PO ${po.reference}`,
      metadata: { reference: po.reference, invoiceNumber: input.invoiceNumber ?? null, lineCount: linesWithQty.length },
    })

    // Queue accounting purchase invoice (bill) sync
    try {
      const settings = await getAccountingSettings()
      const supplierData = await db.purchaseOrder.findUnique({
        where: { id: poId },
        select: { supplier: { select: { name: true, taxRate: { select: { accountingTaxType: true } } } }, currency: true },
      })
      const billTaxType = supplierData?.supplier?.taxRate?.accountingTaxType ?? undefined
      await queueAccountingSync({
        type: 'PURCHASE_INVOICE',
        referenceType: 'PurchaseOrder',
        referenceId: poId,
        payload: {
          invoiceNumber: po.reference,
          contactName: supplierData?.supplier?.name ?? 'Unknown Supplier',
          date: input.invoiceDate,
          dueDate: input.dueDate ?? undefined,
          currency: supplierData?.currency ?? 'GBP',
          reference: input.invoiceNumber ?? undefined,
          // Goods on a PO stay on the balance sheet as Stock-in-Transit until received.
          // The opposite leg (DR Inventory / CR Transit) is posted on goods receipt.
          lines: linesWithQty.map(l => ({
            description: `PO ${po.reference} line`,
            quantity: l.qtyBilled,
            unitAmount: Math.round((l.unitCostForeign / fxRate) * 10000) / 10000,
            accountCode: settings.transitAccount,
            taxType: billTaxType,
          })),
          supplierInvoicePath: input.supplierInvoiceUrl ?? undefined,
        },
      })
    } catch { /* Accounting queue errors should never block the main flow */ }

    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: poId,
      action: 'invoiced',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create invoice for PO ${poId}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Freight / Landed Cost POs
// ---------------------------------------------------------------------------

export type FreightCostLineInput = {
  description: string
  amountForeign: number
  vatable: boolean
  distributionMethod: string
}

export type CreateFreightPoInput = {
  supplierId: string
  currency: string
  fxRateToGbp: number
  primaryPoIds: string[]
  supplierRef?: string
  notes?: string
  taxRateValue?: number
  costLines: FreightCostLineInput[]
}

export async function createFreightPo(input: CreateFreightPoInput): Promise<{ success: boolean; po?: PoRow; error?: string }> {
  try {
    await requireAuth()
    if (!input.costLines.length) return { success: false, error: 'Add at least one cost line' }
    if (!input.primaryPoIds.length) return { success: false, error: 'Link to at least one primary PO' }

    const fxRate = input.fxRateToGbp || 1
    const vatRate = input.taxRateValue ?? 0

    let subtotalForeign = 0
    let taxForeign = 0
    const costLineData = input.costLines.map((cl, i) => {
      const amountGbp = Math.round((cl.amountForeign / fxRate) * 10000) / 10000
      subtotalForeign += cl.amountForeign
      if (cl.vatable && vatRate > 0) taxForeign += Math.round(cl.amountForeign * vatRate * 10000) / 10000
      return {
        description: cl.description,
        amountForeign: cl.amountForeign,
        amountGbp,
        vatable: cl.vatable,
        distributionMethod: cl.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
        sortOrder: i,
      }
    })

    const subtotalGbp = Math.round((subtotalForeign / fxRate) * 10000) / 10000
    const taxGbp = Math.round((taxForeign / fxRate) * 10000) / 10000
    const totalForeign = subtotalForeign + taxForeign
    const totalGbp = subtotalGbp + taxGbp

    const freightReference = await makeReference()
    const po = await db.purchaseOrder.create({
      data: {
        reference: freightReference,
        type: 'FREIGHT',
        supplierId: input.supplierId,
        currency: input.currency,
        fxRateToGbp: fxRate,
        subtotalForeign,
        subtotalGbp,
        taxForeign,
        taxGbp,
        totalForeign,
        totalGbp,
        directFreightForeign: subtotalForeign,
        directFreightGbp: subtotalGbp,
        supplierRef: input.supplierRef || null,
        notes: input.notes || null,
        freightCostLines: { create: costLineData },
        asFreightFor: {
          create: input.primaryPoIds.map((pid) => ({
            primaryPoId: pid,
            method: costLineData[0]?.distributionMethod ?? 'BY_VALUE',
          })),
        },
      },
      select: PO_SELECT,
    })

    // Revalidate linked primary POs
    for (const pid of input.primaryPoIds) {
      revalidatePath(`/purchase-orders/${pid}`)
    }
    revalidatePath('/purchase-orders')
    const mapped = mapPoRow(po)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: mapped.id,
      action: 'created',
      tag: 'purchase',
      level: 'INFO',
      description: `Created freight PO ${mapped.reference}`,
      metadata: { reference: mapped.reference, supplierId: input.supplierId, primaryPoIds: input.primaryPoIds, costLineCount: input.costLines.length },
    })
    return { success: true, po: mapped }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: null,
      action: 'created',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to create freight PO: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

/** Get linked freight POs for a primary PO, with their cost lines */
export async function getLinkedFreightPos(primaryPoId: string) {
  await requireAuth()
  const links = await db.landedCostLink.findMany({
    where: { primaryPoId },
    select: {
      id: true,
      method: true,
      freightPO: {
        select: {
          id: true,
          reference: true,
          status: true,
          currency: true,
          fxRateToGbp: true,
          totalForeign: true,
          totalGbp: true,
          supplier: { select: { name: true } },
          freightCostLines: {
            select: {
              id: true,
              description: true,
              amountForeign: true,
              amountGbp: true,
              distributionMethod: true,
              vatable: true,
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })
  return links.map((l) => ({
    linkId: l.id,
    method: l.method,
    freightPo: {
      id: l.freightPO.id,
      reference: l.freightPO.reference,
      status: l.freightPO.status,
      currency: l.freightPO.currency,
      supplierName: l.freightPO.supplier.name,
      totalForeign: Number(l.freightPO.totalForeign),
      totalGbp: Number(l.freightPO.totalGbp),
      costLines: l.freightPO.freightCostLines.map((cl) => ({
        id: cl.id,
        description: cl.description,
        amountForeign: Number(cl.amountForeign),
        amountGbp: Number(cl.amountGbp),
        distributionMethod: cl.distributionMethod,
        vatable: cl.vatable,
      })),
    },
  }))
}

/** Get all GOODS-type POs for linking (for the freight PO form) */
export async function getGoodsPosForLinking(): Promise<{ id: string; reference: string; supplierName: string; totalForeign: number; currency: string }[]> {
  await requireAuth()
  const pos = await db.purchaseOrder.findMany({
    where: { type: 'GOODS', status: { notIn: ['DRAFT', 'CANCELLED'] } },
    select: {
      id: true,
      reference: true,
      currency: true,
      totalForeign: true,
      supplier: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return pos.map((p) => ({
    id: p.id,
    reference: p.reference,
    supplierName: p.supplier.name,
    totalForeign: Number(p.totalForeign),
    currency: p.currency,
  }))
}

/** Update a freight PO's cost lines and recalculate landed costs on linked primary POs */
export async function updateFreightPoCosts(
  freightPoId: string,
  costLines: FreightCostLineInput[],
  taxRateValue?: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAuth()
    const po = await db.purchaseOrder.findUnique({
      where: { id: freightPoId },
      select: { id: true, reference: true, type: true, fxRateToGbp: true },
    })
    if (!po) return { success: false, error: 'PO not found' }
    if (po.type !== 'FREIGHT') return { success: false, error: 'Not a freight PO' }

    const fxRate = Number(po.fxRateToGbp)
    const vatRate = taxRateValue ?? 0

    // Delete old cost lines and recreate
    await db.freightCostLine.deleteMany({ where: { poId: freightPoId } })

    let subtotalForeign = 0
    let taxForeign = 0
    const lineData = costLines.map((cl, i) => {
      const amountGbp = Math.round((cl.amountForeign / fxRate) * 10000) / 10000
      subtotalForeign += cl.amountForeign
      if (cl.vatable && vatRate > 0) taxForeign += Math.round(cl.amountForeign * vatRate * 10000) / 10000
      return {
        poId: freightPoId,
        description: cl.description,
        amountForeign: cl.amountForeign,
        amountGbp,
        vatable: cl.vatable,
        distributionMethod: cl.distributionMethod as 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QUANTITY' | 'EQUAL_SPLIT',
        sortOrder: i,
      }
    })
    await db.freightCostLine.createMany({ data: lineData })

    const subtotalGbp = Math.round((subtotalForeign / fxRate) * 10000) / 10000
    const taxGbp = Math.round((taxForeign / fxRate) * 10000) / 10000
    const totalForeign = subtotalForeign + taxForeign
    const totalGbp = subtotalGbp + taxGbp

    await db.purchaseOrder.update({
      where: { id: freightPoId },
      data: {
        subtotalForeign,
        subtotalGbp,
        taxForeign,
        taxGbp,
        totalForeign,
        totalGbp,
        directFreightForeign: subtotalForeign,
        directFreightGbp: subtotalGbp,
      },
    })

    // Recalculate landed costs on all linked primary POs
    await recalculateLandedCosts(freightPoId)

    revalidatePath('/purchase-orders')
    revalidatePath(`/purchase-orders/${freightPoId}`)
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: freightPoId,
      action: 'updated',
      tag: 'purchase',
      level: 'INFO',
      description: `Updated freight costs for PO ${po.reference}`,
      metadata: { reference: po.reference, costLineCount: costLines.length },
    })
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'PURCHASE_ORDER',
      entityId: freightPoId,
      action: 'updated',
      tag: 'purchase',
      level: 'ERROR',
      description: `Failed to update freight costs for PO ${freightPoId}: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

/**
 * Recalculate landed cost on all primary POs linked to this freight PO.
 * Updates PO line `landedUnitCostGbp`, CostLayer `unitCostGbp`, and CogsEntry costs.
 */
async function recalculateLandedCosts(freightPoId: string) {
  // Find all primary POs linked to this freight PO
  const links = await db.landedCostLink.findMany({
    where: { freightPoId },
    select: { primaryPoId: true },
  })

  for (const link of links) {
    const primaryPoId = link.primaryPoId

    // Get the primary PO with its lines
    const primaryPo = await db.purchaseOrder.findUnique({
      where: { id: primaryPoId },
      select: {
        id: true,
        subtotalGbp: true,
        directFreightGbp: true,
        lines: {
          select: {
            id: true,
            qty: true,
            unitCostGbp: true,
            totalGbp: true,
            costLayers: {
              select: {
                id: true,
                unitCostGbp: true,
                cogsEntries: { select: { id: true, qty: true } },
              },
            },
          },
        },
      },
    })
    if (!primaryPo) continue

    // Calculate total landed cost for this primary PO from ALL linked freight POs
    const allLinks = await db.landedCostLink.findMany({
      where: { primaryPoId },
      select: {
        freightPO: { select: { totalGbp: true } },
      },
    })
    const totalFreightGbp = allLinks.reduce((s, l) => s + Number(l.freightPO.totalGbp), 0)
      + Number(primaryPo.directFreightGbp)

    const poSubtotalGbp = Number(primaryPo.subtotalGbp)

    // Distribute landed cost to each line and update
    for (const line of primaryPo.lines) {
      const lineQty = Number(line.qty)
      const lineTotalGbp = Number(line.totalGbp)
      const baseUnitCostGbp = Number(line.unitCostGbp)

      if (lineQty <= 0 || poSubtotalGbp <= 0) continue

      // BY_VALUE distribution
      const lineShare = lineTotalGbp / poSubtotalGbp
      const landedForLine = totalFreightGbp * lineShare
      const landedPerUnit = landedForLine / lineQty
      const grossUnitCostGbp = baseUnitCostGbp + landedPerUnit

      // Update PO line landed cost
      await db.purchaseOrderLine.update({
        where: { id: line.id },
        data: { landedUnitCostGbp: grossUnitCostGbp },
      })

      // Update cost layers linked to this PO line
      for (const cl of line.costLayers) {
        await db.costLayer.update({
          where: { id: cl.id },
          data: { unitCostGbp: grossUnitCostGbp },
        })

        // Update any COGS entries that consumed from this layer
        for (const ce of cl.cogsEntries) {
          const ceQty = Number(ce.qty)
          await db.cogsEntry.update({
            where: { id: ce.id },
            data: {
              unitCostGbp: grossUnitCostGbp,
              totalCostGbp: Math.round(ceQty * grossUnitCostGbp * 1000000) / 1000000,
            },
          })
        }
      }
    }

    revalidatePath(`/purchase-orders/${primaryPoId}`)
  }
}
