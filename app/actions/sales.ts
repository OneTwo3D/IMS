'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { queueAccountingSync, getAccountingSettings } from '@/lib/accounting'
import { enqueueAndProcessImmediateWcStockSync } from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'
import { isSellableProductStatus } from '@/lib/products/lifecycle'
import { resolveLineTaxRateBatch, type ResolvedTaxRate } from '@/lib/tax/resolve-rate'
import type { Prisma, TaxCategory } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SoStatus =
  | 'DRAFT' | 'PENDING_PAYMENT' | 'ON_HOLD'
  | 'PROCESSING' | 'ALLOCATED' | 'PICKING' | 'PACKING'
  | 'SHIPPED' | 'COMPLETED' | 'DELIVERED'
  | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'

export type SoLineRow = {
  id: string
  productId: string | null
  sku: string
  imageUrl: string | null
  description: string
  qty: number
  unitPriceForeign: number  // original price before discount
  unitPriceGbp: number
  discountStr: string | null
  discountAmount: number
  taxForeign: number
  taxGbp: number
  totalForeign: number
  totalGbp: number
  cogsGbp: number | null
  /** Per-line tax rate id (resolved from product category + destination). */
  taxRateId: string | null
  /** Per-line effective rate percentage (0..1). Falls back to null if no per-line rate. */
  taxRatePercent: number | null
  /** Short label for the rate (e.g. "REDUCED 5%"). Null when no per-line rate. */
  taxRateName: string | null
}

export type SoRow = {
  id: string
  wcOrderId: number | null
  wcOrderNumber: string | null
  orderNumber: string | null
  status: SoStatus
  currency: string
  fxRateToGbp: number
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: number
  shippingService: string | null
  shippingForeign: number
  taxRateName: string | null
  taxRatePercent: number | null
  taxForeign: number
  pricesIncludeVat: boolean
  totalForeign: number
  totalGbp: number
  shipFromWarehouseId: string | null
  shipFromWarehouseName: string | null
  expectedDelivery: string | null
  salesRep: string | null
  trackingNumber: string | null
  shippedAt: string | null
  discountStr: string | null
  discountAmount: number
  invoiceNumber: string | null
  invoicedAt: string | null
  accountingInvoiceId: string | null
  paidAt: string | null
  notes: string | null
  internalNotes: string | null
  shippingCountryCode: string | null
  paymentMethodTitle: string | null
  wcCreatedAt: string | null
  createdAt: string
  lineCount: number
  cogsGbp: number | null
  profitMarginPercent: number | null
}

export type SoDetail = SoRow & {
  billingAddress: unknown
  shippingAddress: unknown
  lines: SoLineRow[]
  refunds: {
    id: string
    creditNoteNumber: string | null
    reason: string | null
    totalForeign: number
    totalGbp: number
    refundedAt: string
    payments: PaymentRow[]
    lines: {
      id: string
      productId: string | null
      description: string
      qty: number
      totalGbp: number
    }[]
  }[]
  payments: PaymentRow[]
}

export type SoLineInput = {
  productId: string
  sku: string
  description: string
  qty: number
  unitPriceForeign: number
  /**
   * Optional manual override of the tax rate for this line. When null/omitted
   * the server resolves a rate from the product's tax category + destination
   * country. When set, this rate is used verbatim.
   */
  taxRateId?: string | null
}

export type CreateSoInput = {
  customerId?: string
  customerName: string
  customerEmail?: string
  billingAddress?: unknown
  shippingAddress?: unknown
  currency: string
  fxRateToGbp: number
  shipFromWarehouseId?: string
  expectedDelivery?: string
  salesRep?: string
  notes?: string
  internalNotes?: string
  shippingService?: string
  shippingForeign?: number
  taxRateName?: string
  taxRateValue?: number
  pricesIncludeVat?: boolean
  fees?: { description: string; amount: number }[]
  orderDiscountForeign?: number
  orderDiscountStr?: string
  lines: (SoLineInput & { discountStr?: string; discountAmount?: number })[]
  /**
   * When true, the order is saved as a DRAFT and is NOT queued for accounting
   * sync. Drafts remain editable until finalised (moved to PENDING_PAYMENT,
   * PROCESSING, etc.) at which point the accounting invoice is queued.
   */
  isDraft?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReference(prefix: string): string {
  const now = new Date()
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}${ymd}-${rand}`
}

const SO_SELECT = {
  id: true,
  wcOrderId: true,
  wcOrderNumber: true,
  orderNumber: true,
  status: true,
  currency: true,
  fxRateToGbp: true,
  customerName: true,
  customerEmail: true,
  subtotalForeign: true,
  shippingService: true,
  shippingForeign: true,
  taxRateName: true,
  taxRatePercent: true,
  taxForeign: true,
  pricesIncludeVat: true,
  totalForeign: true,
  totalGbp: true,
  shipFromWarehouseId: true,
  shipFromWarehouse: { select: { name: true } },
  expectedDelivery: true,
  salesRep: true,
  trackingNumber: true,
  shippedAt: true,
  discountStr: true,
  discountAmount: true,
  invoiceNumber: true,
  invoicedAt: true,
  accountingInvoiceId: true,
  paidAt: true,
  notes: true,
  internalNotes: true,
  shippingAddress: true,
  paymentMethodTitle: true,
  wcCreatedAt: true,
  createdAt: true,
  _count: { select: { lines: true } },
  lines: { select: { cogsGbp: true } },
} as const

function mapSoRow(so: {
  id: string
  wcOrderId: number | null
  wcOrderNumber: string | null
  orderNumber: string | null
  status: string
  currency: string
  fxRateToGbp: unknown
  customerName: string | null
  customerEmail: string | null
  subtotalForeign: unknown
  shippingService: string | null
  shippingForeign: unknown
  taxRateName: string | null
  taxRatePercent: unknown
  taxForeign: unknown
  pricesIncludeVat: boolean
  totalForeign: unknown
  totalGbp: unknown
  shipFromWarehouseId: string | null
  shipFromWarehouse: { name: string } | null
  expectedDelivery: Date | null
  salesRep: string | null
  trackingNumber: string | null
  shippedAt: Date | null
  discountStr: string | null
  discountAmount: unknown
  invoiceNumber: string | null
  invoicedAt: Date | null
  accountingInvoiceId: string | null
  paidAt: Date | null
  notes: string | null
  internalNotes: string | null
  shippingAddress: unknown
  paymentMethodTitle: string | null
  wcCreatedAt: Date | null
  createdAt: Date
  _count: { lines: number }
  lines: { cogsGbp: unknown }[]
}): SoRow {
  const totalGbp = Number(so.totalGbp)
  const lineCogs = so.lines.map((l) => l.cogsGbp != null ? Number(l.cogsGbp) : null)
  const hasAnyCogs = lineCogs.some((c) => c !== null)
  const cogsGbp = hasAnyCogs ? lineCogs.reduce((s: number, c) => s + (c ?? 0), 0) : null
  const profitMarginPercent = cogsGbp != null && totalGbp > 0
    ? ((totalGbp - cogsGbp) / totalGbp) * 100
    : null
  return {
    id: so.id,
    wcOrderId: so.wcOrderId,
    wcOrderNumber: so.wcOrderNumber,
    orderNumber: so.orderNumber,
    status: so.status as SoStatus,
    currency: so.currency,
    fxRateToGbp: Number(so.fxRateToGbp),
    customerName: so.customerName,
    customerEmail: so.customerEmail,
    subtotalForeign: Number(so.subtotalForeign),
    shippingService: so.shippingService,
    shippingForeign: Number(so.shippingForeign),
    taxRateName: so.taxRateName,
    taxRatePercent: so.taxRatePercent != null ? Number(so.taxRatePercent) : null,
    taxForeign: Number(so.taxForeign),
    pricesIncludeVat: !!so.pricesIncludeVat,
    totalForeign: Number(so.totalForeign),
    totalGbp: Number(so.totalGbp),
    shipFromWarehouseId: so.shipFromWarehouseId,
    shipFromWarehouseName: so.shipFromWarehouse?.name ?? null,
    expectedDelivery: so.expectedDelivery?.toISOString() ?? null,
    salesRep: so.salesRep,
    trackingNumber: so.trackingNumber,
    shippedAt: so.shippedAt?.toISOString() ?? null,
    discountStr: so.discountStr,
    discountAmount: Number(so.discountAmount),
    invoiceNumber: so.invoiceNumber,
    invoicedAt: so.invoicedAt?.toISOString() ?? null,
    accountingInvoiceId: so.accountingInvoiceId,
    paidAt: so.paidAt?.toISOString() ?? null,
    notes: so.notes,
    internalNotes: so.internalNotes,
    shippingCountryCode: (so.shippingAddress as Record<string, string> | null)?.country?.toUpperCase() || null,
    paymentMethodTitle: so.paymentMethodTitle,
    wcCreatedAt: so.wcCreatedAt?.toISOString() ?? null,
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
    cogsGbp,
    profitMarginPercent,
  }
}

function mapLine(l: {
  id: string
  productId: string | null
  sku: string | null
  description: string
  qty: unknown
  unitPriceForeign: unknown
  unitPriceGbp: unknown
  discountStr: string | null
  discountAmount: unknown
  taxForeign: unknown
  taxGbp: unknown
  totalForeign: unknown
  totalGbp: unknown
  cogsGbp: unknown
  taxRateId?: string | null
  taxRate?: { id: string; name: string; rate: unknown; taxCategory?: string } | null
  product?: { imageUrl: string | null; parent?: { imageUrl: string | null } | null } | null
}): SoLineRow {
  return {
    id: l.id,
    productId: l.productId,
    sku: l.sku ?? '',
    imageUrl: l.product?.imageUrl ?? l.product?.parent?.imageUrl ?? null,
    description: l.description,
    qty: Number(l.qty),
    unitPriceForeign: Number(l.unitPriceForeign),
    unitPriceGbp: Number(l.unitPriceGbp),
    discountStr: l.discountStr ?? null,
    discountAmount: Number(l.discountAmount ?? 0),
    taxForeign: Number(l.taxForeign),
    taxGbp: Number(l.taxGbp),
    totalForeign: Number(l.totalForeign),
    totalGbp: Number(l.totalGbp),
    cogsGbp: l.cogsGbp != null ? Number(l.cogsGbp) : null,
    taxRateId: l.taxRateId ?? l.taxRate?.id ?? null,
    taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : null,
    taxRateName: l.taxRate?.name ?? null,
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getSalesOrders(
  limit = 200,
  opts?: { includeCompleted?: boolean }
): Promise<SoRow[]> {
  await requireAuth()
  const where: Prisma.SalesOrderWhereInput = { archived: { not: true } }
  if (!opts?.includeCompleted) {
    where.status = { notIn: ['COMPLETED', 'DELIVERED'] }
  }
  const orders = await db.salesOrder.findMany({
    where,
    select: SO_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return orders.map(mapSoRow)
}

export async function getSalesOrder(id: string): Promise<SoDetail | null> {
  await requireAuth()
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      ...SO_SELECT,
      billingAddress: true,
      shippingAddress: true,
      lines: {
        select: {
          id: true, productId: true, sku: true, description: true,
          qty: true, unitPriceForeign: true, unitPriceGbp: true, discountStr: true, discountAmount: true,
          taxForeign: true, taxGbp: true, totalForeign: true, totalGbp: true,
          cogsGbp: true,
          taxRateId: true,
          taxRate: { select: { id: true, name: true, rate: true, taxCategory: true } },
          product: { select: { imageUrl: true, parent: { select: { imageUrl: true } } } },
        },
      },
      refunds: {
        select: {
          id: true, creditNoteNumber: true, reason: true, totalForeign: true, totalGbp: true, refundedAt: true,
          lines: {
            select: { id: true, productId: true, description: true, qty: true, totalGbp: true },
          },
          payments: {
            select: { id: true, amount: true, currency: true, method: true, reference: true, notes: true, paidAt: true },
            orderBy: { paidAt: 'desc' },
          },
        },
        orderBy: { refundedAt: 'desc' },
      },
      payments: {
        select: { id: true, refundId: true, amount: true, currency: true, method: true, reference: true, notes: true, paidAt: true },
        orderBy: { paidAt: 'desc' },
      },
    },
  })
  if (!so) return null

  return {
    ...mapSoRow(so),
    billingAddress: so.billingAddress,
    shippingAddress: so.shippingAddress,
    lines: so.lines.map(mapLine),
    refunds: so.refunds.map((r) => ({
      id: r.id,
      creditNoteNumber: r.creditNoteNumber,
      reason: r.reason,
      totalForeign: Number(r.totalForeign),
      totalGbp: Number(r.totalGbp),
      refundedAt: r.refundedAt.toISOString(),
      payments: (r.payments ?? []).map((p) => ({
        id: p.id, refundId: r.id, creditNoteNumber: r.creditNoteNumber,
        amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, notes: p.notes, paidAt: p.paidAt.toISOString(),
      })),
      lines: r.lines.map((rl) => ({
        id: rl.id,
        productId: rl.productId,
        description: rl.description,
        qty: Number(rl.qty),
        totalGbp: Number(rl.totalGbp),
      })),
    })),
    payments: so.payments.map((p) => ({
      id: p.id, refundId: p.refundId, creditNoteNumber: null,
      amount: Number(p.amount), currency: p.currency, method: p.method, reference: p.reference, notes: p.notes, paidAt: p.paidAt.toISOString(),
    })),
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createSalesOrder(input: CreateSoInput): Promise<{ success: boolean; order?: SoRow; error?: string }> {
  try {
    await requirePermission('sales.create')
    if (!input.lines.length) return { success: false, error: 'Add at least one line item' }
    if (!input.customerName?.trim()) return { success: false, error: 'Customer name is required' }
    for (const l of input.lines) {
      if (l.qty <= 0) return { success: false, error: `Invalid qty for ${l.sku}` }
      if (l.unitPriceForeign < 0) return { success: false, error: `Negative price for ${l.sku}` }
    }

    const fxRate = input.fxRateToGbp && input.fxRateToGbp > 0 ? input.fxRateToGbp : 1
    const vatRate = input.taxRateValue ?? 0
    const inclVat = !!input.pricesIncludeVat
    // Storage convention:
    //   All *Foreign / *Gbp totals on SalesOrder are NET of tax (subtotal,
    //   shipping, discount). `taxForeign` holds the total VAT, `totalForeign`
    //   is the grand total (net + tax). Line rows also store NET totals.
    //   When pricesIncludeVat is true, unitPriceForeign remains the gross
    //   user-entered price so the UI can display gross values, but every
    //   aggregate field is net. The Xero payload reconstructs gross from
    //   stored net when lineAmountsIncludeTax is true.
    let linesSubtotalForeign = 0 // sum of line NETs, before order discount
    let linesSubtotalGbp = 0
    let totalTaxForeign = 0
    let totalTaxGbp = 0

    const round4 = (n: number) => Math.round(n * 10000) / 10000

    // --- Tax category resolution ---------------------------------------
    // Load each line's product category + the order default rate so we can
    // resolve a per-line VAT rate via `(destCountry, category, SALES)`.
    // Manual overrides (input.lines[i].taxRateId) skip the resolver and use
    // the rate row directly.
    const shipAddr = input.shippingAddress as { country?: string | null } | null | undefined
    const billAddr = input.billingAddress as { country?: string | null } | null | undefined
    let destCountryRaw: string | null =
      (shipAddr?.country as string | null | undefined) ??
      (billAddr?.country as string | null | undefined) ??
      null
    if (!destCountryRaw) {
      try {
        const { getOrganisation } = await import('./company')
        const org = await getOrganisation()
        destCountryRaw = org?.country ?? null
      } catch { /* Fallback to null — resolver will use order default */ }
    }
    // Normalize free-text country values ("United Kingdom", "UK", "gb") to
    // the lowercase ISO-2 code the resolver compares against.
    const { toIsoCountryCode } = await import('@/lib/countries')
    const destCountryIso = toIsoCountryCode(destCountryRaw)
    const destCountry: string | null = destCountryIso ? destCountryIso.toLowerCase() : (destCountryRaw ? destCountryRaw.toLowerCase() : null)

    const productIds = Array.from(new Set(input.lines.map((l) => l.productId).filter(Boolean)))
    const productRows = productIds.length
      ? await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, taxCategory: true, lifecycleStatus: true },
        })
      : []
    const invalidSalesProduct = productRows.find((p) => !isSellableProductStatus(p.lifecycleStatus))
    if (invalidSalesProduct) {
      return { success: false, error: 'Only active products can be sold on sales orders' }
    }
    const productCategoryById = new Map<string, TaxCategory>(
      productRows.map((p) => [p.id, p.taxCategory]),
    )

    // Order-level default for the resolver fallback step
    const orderDefaultRate = input.taxRateName
      ? await db.taxRate.findFirst({
          where: { name: input.taxRateName, active: true },
          select: { id: true, name: true, rate: true, accountingTaxType: true },
        })
      : null
    const orderDefaultCtx = {
      id: orderDefaultRate?.id ?? null,
      name: orderDefaultRate?.name ?? input.taxRateName ?? null,
      rate: orderDefaultRate ? Number(orderDefaultRate.rate) : vatRate,
      accountingTaxType: orderDefaultRate?.accountingTaxType ?? null,
    }

    // Batch-resolve all lines that don't already carry a manual taxRateId.
    const autoLines = input.lines
      .map((l, idx) => ({
        id: String(idx),
        productCategory: (l.productId && productCategoryById.get(l.productId)) || ('STANDARD' as TaxCategory),
        override: l.taxRateId ?? null,
      }))
      .filter((l) => !l.override)
    const resolvedMap = await resolveLineTaxRateBatch(autoLines, {
      destinationCountry: destCountry,
      usedFor: 'SALES',
      orderDefault: orderDefaultCtx,
    })

    // Load any manual override tax rates in one query.
    const overrideIds = Array.from(
      new Set(
        input.lines
          .map((l) => l.taxRateId)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    )
    const overrideRows = overrideIds.length
      ? await db.taxRate.findMany({
          where: { id: { in: overrideIds } },
          select: { id: true, name: true, rate: true, accountingTaxType: true },
        })
      : []
    const overrideById = new Map(overrideRows.map((r) => [r.id, r]))

    const lineResolved: ResolvedTaxRate[] = input.lines.map((l, idx) => {
      if (l.taxRateId) {
        const row = overrideById.get(l.taxRateId)
        if (row) {
          return {
            taxRateId: row.id,
            taxRateName: row.name,
            taxRateValue: Number(row.rate),
            accountingTaxType: row.accountingTaxType,
            matched: 'exact',
            warning: null,
          }
        }
      }
      return (
        resolvedMap.get(String(idx)) ?? {
          taxRateId: orderDefaultCtx.id,
          taxRateName: orderDefaultCtx.name,
          taxRateValue: orderDefaultCtx.rate,
          accountingTaxType: orderDefaultCtx.accountingTaxType,
          matched: 'fallback',
          warning: null,
        }
      )
    })

    const lineData = input.lines.map((l, idx) => {
      const resolved = lineResolved[idx]
      const lineRate = resolved.taxRateValue
      const lineInclVat = inclVat && lineRate > 0
      const discAmt = l.discountAmount ?? 0 // in gross if inclVat, else net
      const lineGross = l.qty * l.unitPriceForeign - discAmt
      const netForeign = lineInclVat ? lineGross / (1 + lineRate) : lineGross
      const unitPriceGbp = Math.round((l.unitPriceForeign / fxRate) * 1000000) / 1000000
      const totalForeign = round4(netForeign)
      const totalGbp = round4(totalForeign / fxRate)
      const lineTax = lineInclVat ? lineGross - netForeign : netForeign * lineRate
      const lineTaxForeign = round4(lineTax)
      const lineTaxGbp = round4(lineTaxForeign / fxRate)
      linesSubtotalForeign += totalForeign
      linesSubtotalGbp += totalGbp
      totalTaxForeign += lineTaxForeign
      totalTaxGbp += lineTaxGbp
      return {
        productId: l.productId,
        sku: l.sku,
        description: l.description,
        qty: l.qty,
        unitPriceForeign: l.unitPriceForeign, // ORIGINAL (gross if inclVat)
        unitPriceGbp,
        discountStr: l.discountStr || null,
        discountAmount: discAmt,
        taxForeign: lineTaxForeign,
        taxGbp: lineTaxGbp,
        totalForeign, // NET
        totalGbp,
        taxRateId: resolved.taxRateId,
      }
    })

    // Shipping (+ fees). Input shippingForeign is gross when inclVat.
    // Shipping / fees / order discount are always taxed at the order-default
    // rate (the per-line resolver only applies to line items).
    const shippingInclVat = inclVat && vatRate > 0
    const shippingInput = input.shippingForeign ?? 0
    let feesTotalForeign = 0
    if (input.fees?.length) for (const f of input.fees) feesTotalForeign += f.amount
    const totalShippingInput = shippingInput + feesTotalForeign
    const shippingNetForeign = shippingInclVat ? totalShippingInput / (1 + vatRate) : totalShippingInput
    const shippingTaxForeign = shippingInclVat
      ? totalShippingInput - shippingNetForeign
      : (vatRate > 0 ? shippingNetForeign * vatRate : 0)
    const shippingNetForeignR = round4(shippingNetForeign)
    const shippingTaxForeignR = round4(shippingTaxForeign)
    const shippingNetGbp = round4(shippingNetForeignR / fxRate)
    const shippingTaxGbp = round4(shippingTaxForeignR / fxRate)
    totalTaxForeign += shippingTaxForeignR
    totalTaxGbp += shippingTaxGbp

    // Order-level discount — cap at line subtotal (compare in gross when inclVat).
    const rawOrderDisc = input.orderDiscountForeign ?? 0
    const linesGrossForCap = shippingInclVat
      ? linesSubtotalForeign * (1 + vatRate)
      : linesSubtotalForeign
    const orderDiscForeign = Math.min(rawOrderDisc, linesGrossForCap)
    const discNetForeign = shippingInclVat ? orderDiscForeign / (1 + vatRate) : orderDiscForeign
    const discTaxForeign = shippingInclVat ? orderDiscForeign - discNetForeign : (vatRate > 0 ? discNetForeign * vatRate : 0)
    const discNetForeignR = round4(discNetForeign)
    const discTaxForeignR = round4(discTaxForeign)
    const discNetGbp = round4(discNetForeignR / fxRate)
    const discTaxGbp = round4(discTaxForeignR / fxRate)
    totalTaxForeign -= discTaxForeignR
    totalTaxGbp -= discTaxGbp

    // Subtotal stored PRE-discount (sum of line nets) — matches the WC
    // importer convention so display / accounting code can handle both
    // sources uniformly.
    const subtotalForeign = round4(linesSubtotalForeign)
    const subtotalGbp = round4(linesSubtotalGbp)
    totalTaxForeign = round4(totalTaxForeign)
    totalTaxGbp = round4(totalTaxGbp)

    // Grand total = subtotal (net, pre-discount) − net discount + net
    // shipping + total tax. Tax already nets the discount VAT above.
    const grandTotalForeign = round4(subtotalForeign - discNetForeignR + shippingNetForeignR + totalTaxForeign)
    const grandTotalGbp = round4(subtotalGbp - discNetGbp + shippingNetGbp + totalTaxGbp)

    // Keep locals that downstream Prisma / accounting queue references expect.
    const totalShippingForeign = shippingNetForeignR
    const totalShippingGbp = shippingNetGbp
    // Store the order discount in the same convention as WC import: the raw
    // user-entered amount (gross when inclVat).
    const storedDiscountAmount = round4(orderDiscForeign)

    // Generate order number using configured prefix (Settings → Company → Numbering)
    const { getNumberingFormats } = await import('./company')
    const numbering = await getNumberingFormats()
    const ref = makeReference(numbering.so_prefix)
    const orderNumber = ref

    // Drafts stay in DRAFT and are NOT queued for accounting sync. When the
    // order is finalised later (e.g. moved to PENDING_PAYMENT), the invoice
    // will be queued via updateSalesOrderStatus.
    const initialStatus = input.isDraft ? 'DRAFT' : 'PENDING_PAYMENT'
    const so = await db.salesOrder.create({
      data: {
        orderNumber,
        status: initialStatus,
        currency: input.currency,
        fxRateToGbp: fxRate,
        customerId: input.customerId || null,
        customerName: input.customerName,
        customerEmail: input.customerEmail || null,
        billingAddress: input.billingAddress ?? undefined,
        shippingAddress: input.shippingAddress ?? undefined,
        subtotalForeign,
        shippingService: input.shippingService || null,
        shippingForeign: totalShippingForeign,
        taxRateName: input.taxRateName || null,
        taxRatePercent: vatRate > 0 ? vatRate : null,
        taxForeign: totalTaxForeign,
        pricesIncludeVat: inclVat,
        totalForeign: grandTotalForeign,
        subtotalGbp,
        shippingGbp: totalShippingGbp,
        taxGbp: totalTaxGbp,
        totalGbp: grandTotalGbp,
        shipFromWarehouseId: input.shipFromWarehouseId || null,
        expectedDelivery: input.expectedDelivery ? new Date(input.expectedDelivery) : null,
        salesRep: input.salesRep || null,
        discountStr: input.orderDiscountStr || null,
        discountAmount: storedDiscountAmount,
        notes: input.notes || null,
        internalNotes: input.internalNotes || null,
        lines: { create: lineData },
      },
      select: SO_SELECT,
    })

    // Auto-allocate stock across warehouses. Drafts stay unallocated —
    // allocation happens when the draft is finalised so the draft can still
    // be freely edited without holding stock.
    if (!input.isDraft) {
      const { autoAllocateOrder } = await import('./allocation')
      await autoAllocateOrder(so.id)
    }

    // Queue accounting sales invoice (DRAFT — manual orders have no payment yet).
    // Skipped entirely for DRAFT orders — drafts are not posted to accounting
    // until they are finalised via updateSalesOrderStatus.
    if (!input.isDraft) {
      try {
        const settings = await getAccountingSettings()
        // The accounting payload uses a generic `lineAmountsIncludeTax`
        // flag — each connector maps this to its native convention. When
        // inclVat, shipping and discount must be sent GROSS. Our DB stores
        // shipping NET and the raw order discount (gross when inclVat) so
        // we reconstruct the right values here.
        const discountGbp = Math.round(((input.orderDiscountForeign ?? 0) / fxRate) * 100) / 100
        const shippingGrossForeign = shippingInclVat ? totalShippingInput : totalShippingForeign
        const shippingSendGbp = round4(shippingGrossForeign / fxRate)
        // Manual invoice prefix comes from unified numbering settings
        const manualPrefix = numbering.inv_prefix
        await queueAccountingSync({
          type: 'SALES_INVOICE',
          referenceType: 'SalesOrder',
          referenceId: so.id,
          payload: {
            invoiceNumber: `${manualPrefix}${orderNumber}`,
            contactName: input.customerName,
            contactEmail: input.customerEmail || undefined,
            date: new Date().toISOString().slice(0, 10),
            currency: input.currency,
            reference: orderNumber,
            lines: lineData.map((l, idx) => {
              // Pass the raw per-line discount amount (in GBP) through.
              // Each accounting connector decides how to represent it
              // natively (rate vs. amount, sales vs. bill, etc.).
              const discAmtGbp = Number(l.discountAmount ?? 0) / fxRate
              return {
                itemCode: l.sku ?? undefined,
                description: l.description ?? l.sku ?? 'Item',
                quantity: l.qty,
                // unitPriceGbp holds the user-entered price (gross when inclVat)
                // which matches lineAmountsIncludeTax.
                unitAmount: Number(l.unitPriceGbp),
                accountCode: settings.salesAccount,
                taxType: lineResolved[idx]?.accountingTaxType ?? orderDefaultCtx.accountingTaxType ?? undefined,
                discountAmount: discAmtGbp > 0 ? Math.round(discAmtGbp * 10000) / 10000 : undefined,
              }
            }),
            shippingAmount: shippingSendGbp > 0 ? shippingSendGbp : undefined,
            shippingDescription: 'Shipping',
            shippingAccountCode: settings.shippingAccount || undefined,
            shippingTaxType: orderDefaultCtx.accountingTaxType ?? undefined,
            discountAmount: discountGbp > 0 ? discountGbp : undefined,
            discountAccountCode: settings.discountAccount || undefined,
            discountTaxType: orderDefaultCtx.accountingTaxType ?? undefined,
            lineAmountsIncludeTax: inclVat,
            _postingMode: 'draft',
          },
        })
      } catch { /* Accounting queue errors should never block the main flow */ }
    }

    // Aggregated warning when any line fell back to the order default.
    const fallbackLines = lineResolved
      .map((r, i) => ({ r, sku: input.lines[i].sku, cat: productCategoryById.get(input.lines[i].productId) ?? 'STANDARD' }))
      .filter((x) => x.r.matched === 'fallback')
    if (fallbackLines.length > 0) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'tax_rate_fallback',
        tag: 'sales',
        level: 'WARNING',
        description: `No matching tax rate for ${destCountry?.toUpperCase() ?? 'unknown country'} on ${fallbackLines.length} line(s); used order default.`,
        metadata: {
          orderNumber: so.orderNumber,
          destCountry,
          lines: fallbackLines.map((x) => ({ sku: x.sku, category: x.cat })),
        },
      })
    }

    revalidatePath('/sales')
    const mapped = mapSoRow(so)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'created',
      tag: 'sales',
      level: 'INFO',
      description: `Created sales order ${mapped.orderNumber ?? mapped.wcOrderNumber}`,
      metadata: { orderNumber: mapped.orderNumber, totalGbp: mapped.totalGbp, currency: mapped.currency },
    })
    return { success: true, order: mapped }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: null,
      action: 'created',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to create sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

/** Release reserved stock for all lines of an order */
async function releaseReservedStock(orderId: string, warehouseId: string, lines: { productId: string | null; qty: unknown }[]) {
  for (const line of lines) {
    if (!line.productId) continue
    const qty = Number(line.qty)
    await db.stockLevel.updateMany({
      where: { productId: line.productId, warehouseId },
      data: { reservedQty: { decrement: qty } },
    })
  }
  await logActivity({
    entityType: 'STOCK_ADJUSTMENT',
    entityId: orderId,
    action: 'reservation_released',
    tag: 'stock',
    level: 'INFO',
    description: `Released reserved stock for order ${orderId}`,
    metadata: { orderId, warehouseId },
  })
}

/**
 * Queue the accounting sales invoice for an existing SalesOrder. Used when a
 * draft order is finalised (DRAFT → PENDING_PAYMENT / PROCESSING / etc.) — the
 * invoice was skipped at creation time and must now be sent to Xero.
 *
 * Safe to call multiple times: checks `accountingInvoiceId` and bails if the
 * invoice has already been posted.
 */
async function queueSalesInvoiceForOrder(id: string): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      wcOrderNumber: true,
      currency: true,
      fxRateToGbp: true,
      customerName: true,
      customerEmail: true,
      shippingForeign: true,
      shippingGbp: true,
      taxRateName: true,
      taxRatePercent: true,
      pricesIncludeVat: true,
      discountAmount: true,
      accountingInvoiceId: true,
      lines: {
        select: {
          sku: true,
          description: true,
          qty: true,
          unitPriceGbp: true,
          unitPriceForeign: true,
          discountAmount: true,
          totalForeign: true,
          taxRateId: true,
          taxRate: { select: { accountingTaxType: true } },
        },
      },
    },
  })
  if (!so) return
  if (so.accountingInvoiceId) return // already posted to accounting

  const settings = await getAccountingSettings()
  if (!settings.syncEnabled) return

  const { getNumberingFormats } = await import('./company')
  const numbering = await getNumberingFormats()
  const manualPrefix = numbering.inv_prefix
  const orderNumber = so.orderNumber ?? so.wcOrderNumber ?? so.id

  const orderDefaultTaxType = so.taxRateName
    ? (await db.taxRate.findFirst({
        where: { name: so.taxRateName, active: true },
        select: { accountingTaxType: true },
      }))?.accountingTaxType ?? null
    : null

  const fxRate = Number(so.fxRateToGbp) || 1
  const vatPct = Number(so.taxRatePercent ?? 0)
  const lineAmountsIncludeTax = !!so.pricesIncludeVat && vatPct > 0

  // Shipping is stored NET on the SalesOrder. Reconstruct gross when
  // sending inclusive so Xero calculates the correct tax.
  const shippingNetGbp = Number(so.shippingGbp ?? 0)
  const shippingSendGbp = lineAmountsIncludeTax
    ? Math.round(shippingNetGbp * (1 + vatPct) * 10000) / 10000
    : shippingNetGbp

  // `discountAmount` is stored in the same inclusive/exclusive convention as
  // the order (matching WC import), so it can be passed through directly.
  const discountGbp = Math.round((Number(so.discountAmount ?? 0) / fxRate) * 100) / 100

  await queueAccountingSync({
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: so.id,
    payload: {
      invoiceNumber: `${manualPrefix}${orderNumber}`,
      contactName: so.customerName ?? 'Unknown',
      contactEmail: so.customerEmail ?? undefined,
      date: new Date().toISOString().slice(0, 10),
      currency: so.currency,
      reference: orderNumber,
      lines: so.lines.map((l) => {
        // `discountAmount` on the line is stored in the order's foreign
        // currency. Pass through in GBP (matching unitAmount's convention)
        // — the accounting connector decides how to represent it.
        const qty = Number(l.qty)
        const discForeign = Number(l.discountAmount ?? 0)
        const discGbp = discForeign > 0 ? Math.round((discForeign / fxRate) * 10000) / 10000 : 0
        return {
          itemCode: l.sku ?? undefined,
          description: l.description ?? l.sku ?? 'Item',
          quantity: qty,
          // unitPriceGbp stores the user-entered price (gross when inclVat),
          // matching lineAmountsIncludeTax.
          unitAmount: Number(l.unitPriceGbp),
          accountCode: settings.salesAccount,
          taxType: l.taxRate?.accountingTaxType ?? orderDefaultTaxType ?? undefined,
          discountAmount: discGbp > 0 ? discGbp : undefined,
        }
      }),
      shippingAmount: shippingSendGbp > 0 ? shippingSendGbp : undefined,
      shippingDescription: 'Shipping',
      shippingAccountCode: settings.shippingAccount || undefined,
      shippingTaxType: orderDefaultTaxType ?? undefined,
      discountAmount: discountGbp > 0 ? discountGbp : undefined,
      discountAccountCode: settings.discountAccount || undefined,
      discountTaxType: orderDefaultTaxType ?? undefined,
      lineAmountsIncludeTax,
      _postingMode: 'draft',
    },
  })
}

export async function updateSalesOrderStatus(
  id: string,
  targetStatus: SoStatus,
  extra?: { trackingNumber?: string; shipFromWarehouseId?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.process')
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { id: true, orderNumber: true, wcOrderId: true, wcOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { id: true, productId: true, sku: true, qty: true } } },
    })
    if (!so) return { success: false, error: 'Order not found' }

    // Valid status transitions
    const VALID_TRANSITIONS: Record<string, string[]> = {
      DRAFT: ['PROCESSING', 'PENDING_PAYMENT', 'CANCELLED', 'ON_HOLD'],
      PENDING_PAYMENT: ['PROCESSING', 'DRAFT', 'CANCELLED', 'ON_HOLD'],
      ON_HOLD: ['DRAFT', 'PROCESSING', 'CANCELLED'],
      PROCESSING: ['ALLOCATED', 'CANCELLED', 'ON_HOLD'],
      ALLOCATED: ['PICKING', 'PROCESSING', 'CANCELLED', 'ON_HOLD'],
      PICKING: ['PACKING', 'CANCELLED', 'ON_HOLD'],
      PACKING: ['SHIPPED', 'CANCELLED', 'ON_HOLD'],
      SHIPPED: ['COMPLETED'],
      COMPLETED: ['DELIVERED'],
    }
    const allowed = VALID_TRANSITIONS[so.status] ?? []
    if (!allowed.includes(targetStatus)) {
      return { success: false, error: `Cannot transition from ${so.status} to ${targetStatus}` }
    }

    // Guard: cannot start picking without allocations (legacy flow only)
    if (targetStatus === 'PICKING') {
      const allocCount = await db.orderAllocation.count({ where: { orderId: id } })
      if (allocCount === 0) {
        return { success: false, error: 'Cannot start picking — no products have been allocated. Allocate stock first.' }
      }
    }

    const data: Record<string, unknown> = { status: targetStatus }

    // On SHIPPED: check if shipments exist (new flow) or use legacy single-warehouse flow
    if (targetStatus === 'SHIPPED') {
      const shipmentCount = await db.shipment.count({ where: { orderId: id } })
      if (shipmentCount > 0) {
        // New multi-shipment flow — shipping is handled per-shipment via updateShipmentStatus
        // This direct SHIPPED transition should only happen when all shipments are already shipped
        const unshipped = await db.shipment.count({ where: { orderId: id, status: { not: 'SHIPPED' } } })
        if (unshipped > 0) {
          return { success: false, error: 'Ship individual shipments first — not all shipments are shipped yet' }
        }
        data.shippedAt = new Date()
        if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
      } else {
        // Legacy single-warehouse flow
        const warehouseId = extra?.shipFromWarehouseId || so.shipFromWarehouseId
        if (!warehouseId) return { success: false, error: 'A warehouse must be selected before shipping' }
        data.shippedAt = new Date()
        if (extra?.trackingNumber) data.trackingNumber = extra.trackingNumber
        if (extra?.shipFromWarehouseId) data.shipFromWarehouseId = extra.shipFromWarehouseId

        // Release allocations
        const allocs = await db.orderAllocation.findMany({ where: { orderId: id } })
        if (allocs.length > 0) {
          for (const alloc of allocs) {
            await db.stockLevel.updateMany({
              where: { productId: alloc.productId, warehouseId: alloc.warehouseId },
              data: { reservedQty: { decrement: Number(alloc.qty) } },
            })
          }
        } else if (so.shipFromWarehouseId) {
          await releaseReservedStock(id, warehouseId, so.lines)
        }

        for (const line of so.lines) {
          if (!line.productId) continue
          const qty = Number(line.qty)
          await db.stockMovement.create({
            data: {
              type: 'SALE_DISPATCH',
              productId: line.productId,
              fromWarehouseId: warehouseId,
              qty,
              note: `Dispatched for order`,
              referenceType: 'SalesOrder',
              referenceId: id,
            },
          })
          await db.stockLevel.updateMany({
            where: { productId: line.productId, warehouseId },
            data: { quantity: { decrement: qty } },
          })
          await logActivity({
            entityType: 'STOCK_ADJUSTMENT',
            entityId: line.productId,
            action: 'dispatched',
            tag: 'stock',
            level: 'INFO',
            description: `Dispatched ${qty} units of SKU ${line.sku ?? line.productId} for order ${so.orderNumber ?? so.wcOrderNumber}`,
            metadata: { sku: line.sku, productId: line.productId, qty, orderNumber: so.orderNumber ?? so.wcOrderNumber, warehouseId },
          })
        }
      }
    }

    if (targetStatus === 'CANCELLED' && so.status === 'SHIPPED') {
      return { success: false, error: 'Cannot cancel a shipped order — process a refund instead' }
    }

    // On CANCEL: release all allocations
    if (targetStatus === 'CANCELLED') {
      const { deallocateOrder } = await import('./allocation')
      await deallocateOrder(id)
      // Also delete any pending shipments
      await db.shipment.deleteMany({ where: { orderId: id, status: { in: ['PENDING', 'PICKING', 'PACKED'] as const } } })
    }

    await db.salesOrder.update({ where: { id }, data })

    // Draft finalisation: when a DRAFT is moved to any non-cancelled status,
    // allocate stock (skipped at creation) and queue the sales invoice for
    // accounting sync (also skipped at creation).
    if (so.status === 'DRAFT' && targetStatus !== 'CANCELLED' && targetStatus !== 'DRAFT') {
      try {
        const { autoAllocateOrder } = await import('./allocation')
        await autoAllocateOrder(id)
      } catch { /* Allocation failures must not block the status transition */ }
      try {
        await queueSalesInvoiceForOrder(id)
      } catch { /* Accounting queue errors should never block status transitions */ }
    }

    // Auto-generate invoice on ship if configured (skip its own log —
    // the status_changed entry below covers both actions)
    if (targetStatus === 'SHIPPED') {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_shipped') {
        await generateInvoiceNumber(id, { skipLog: true })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'INFO',
      description: `Updated sales order ${so.orderNumber ?? so.wcOrderNumber} status to ${targetStatus}`,
      metadata: { orderNumber: so.orderNumber ?? so.wcOrderNumber, previousStatus: so.status, newStatus: targetStatus },
    })

    // Push status to WooCommerce (fire-and-forget)
    if (so.wcOrderId) {
      import('@/lib/connectors/woocommerce/sync/order-status').then((m) =>
        m.pushImsStatusToWc(id, targetStatus as never).catch(() => {}),
      )
    }

    if (targetStatus === 'SHIPPED') {
      try {
        await enqueueAndProcessImmediateWcStockSync(
          so.lines.map((line) => line.productId).filter((value): value is string => !!value),
          'IMS_CHANGE',
        )
      } catch (syncError) {
        console.error(syncError)
      }
    }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'status_changed',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to update sales order status: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function createRefund(
  orderId: string,
  lines: { productId: string | null; description: string; qty: number; totalGbp: number }[],
  reason: string,
  returnWarehouseId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.refund')
    const so = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true, wcOrderNumber: true, orderNumber: true, status: true, fxRateToGbp: true, totalGbp: true,
        revenueDeferredDate: true, unearnedRevenueAmount: true,
        inventoryAllocatedDate: true, allocationBatchAmount: true,
      },
    })
    if (!so) return { success: false, error: 'Order not found' }

    // Accept lines with qty > 0 (item refund) or totalGbp > 0 (monetary-only refund)
    const refundLines = lines.filter((l) => l.qty > 0 || l.totalGbp > 0)
    if (!refundLines.length) return { success: false, error: 'Select at least one line to refund' }

    const fxRate = Number(so.fxRateToGbp) || 1
    const totalGbp = refundLines.reduce((s, l) => s + l.totalGbp, 0)

    // Validate refund doesn't exceed order total
    const existingRefunds = await db.salesOrderRefund.findMany({ where: { orderId }, select: { totalGbp: true } })
    const previouslyRefunded = existingRefunds.reduce((s, r) => s + Number(r.totalGbp), 0)
    if (totalGbp + previouslyRefunded > Number(so.totalGbp) * 1.001) { // small tolerance for rounding
      return { success: false, error: 'Refund total would exceed order total' }
    }
    const totalForeign = Math.round(totalGbp * fxRate * 10000) / 10000

    // Generate credit note number using configured prefix
    const { getNumberingFormats } = await import('./company')
    const numbering = await getNumberingFormats()
    const cnCount = await db.salesOrderRefund.count({ where: { creditNoteNumber: { not: null } } })
    const creditNoteNumber = `${numbering.cn_prefix}${new Date().getFullYear()}-${String(cnCount + 1).padStart(5, '0')}`

    const createdRefund = await db.salesOrderRefund.create({
      data: {
        orderId,
        creditNoteNumber,
        reason: reason || null,
        totalForeign,
        totalGbp,
        returnWarehouseId: returnWarehouseId || null,
        lines: {
          create: refundLines.map((l) => ({
            productId: l.productId,
            description: l.description,
            qty: l.qty,
            unitPriceGbp: l.qty > 0 ? l.totalGbp / l.qty : 0,
            totalGbp: l.totalGbp,
          })),
        },
      },
      select: { id: true },
    })

    // Return stock if warehouse specified
    if (returnWarehouseId) {
      for (const l of refundLines) {
        if (!l.productId) continue
        await db.stockMovement.create({
          data: {
            type: 'RETURN_INBOUND',
            productId: l.productId,
            toWarehouseId: returnWarehouseId,
            qty: l.qty,
            note: `Refund return`,
            referenceType: 'SalesOrder',
            referenceId: orderId,
          },
        })
        await db.stockLevel.upsert({
          where: { productId_warehouseId: { productId: l.productId, warehouseId: returnWarehouseId } },
          create: { productId: l.productId, warehouseId: returnWarehouseId, quantity: l.qty, reservedQty: 0 },
          update: { quantity: { increment: l.qty } },
        })
        await logActivity({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: l.productId,
          action: 'return_inbound',
          tag: 'stock',
          level: 'INFO',
          description: `Returned ${l.qty} units of ${l.description} to warehouse ${returnWarehouseId} for refund on order ${so.orderNumber ?? so.wcOrderNumber}`,
          metadata: { productId: l.productId, qty: l.qty, orderNumber: so.orderNumber ?? so.wcOrderNumber, warehouseId: returnWarehouseId },
        })
      }
    }

    // Update order status based on total refunded vs order total
    const totalRefundedNow = previouslyRefunded + totalGbp
    const orderTotal = Number(so.totalGbp)
    const newStatus = totalRefundedNow >= orderTotal * 0.999 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    await db.salesOrder.update({
      where: { id: orderId },
      data: { status: newStatus },
    })

    revalidatePath('/sales')
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'INFO',
      description: `Created refund for order ${so.orderNumber ?? so.wcOrderNumber} — £${totalGbp.toFixed(2)}`,
      metadata: { orderNumber: so.orderNumber ?? so.wcOrderNumber, totalGbp, creditNoteNumber, reason },
    })
    if (returnWarehouseId) {
      try {
        await enqueueAndProcessImmediateWcStockSync(
          refundLines.map((line) => line.productId).filter((value): value is string => !!value),
          'IMS_CHANGE',
        )
      } catch (syncError) {
        console.error(syncError)
      }
    }

    // Queue accounting credit note sync
    try {
      const settings = await getAccountingSettings()
      const orderForCN = await db.salesOrder.findUnique({
        where: { id: orderId },
        select: { customer: { select: { firstName: true, lastName: true, email: true } }, currency: true, taxRateName: true },
      })
      const cnContactName = orderForCN?.customer
        ? `${orderForCN.customer.firstName} ${orderForCN.customer.lastName}`.trim()
        : 'Walk-in Customer'
      // Look up accounting tax type from the order's tax rate
      const cnTaxRate = orderForCN?.taxRateName
        ? await db.taxRate.findFirst({ where: { name: orderForCN.taxRateName, active: true }, select: { accountingTaxType: true } })
        : null
      await queueAccountingSync({
        type: 'CREDIT_NOTE',
        referenceType: 'SalesOrderRefund',
        referenceId: createdRefund.id,
        payload: {
          creditNoteNumber,
          contactName: cnContactName,
          contactEmail: orderForCN?.customer?.email ?? undefined,
          date: new Date().toISOString().slice(0, 10),
          currency: orderForCN?.currency ?? 'GBP',
          reference: so.wcOrderNumber ?? undefined,
          lines: refundLines.map(l => ({
            description: l.description || 'Refund line',
            quantity: l.qty > 0 ? l.qty : 1,
            unitAmount: l.qty > 0 ? l.totalGbp / l.qty : l.totalGbp,
            accountCode: settings.salesAccount,
            taxType: cnTaxRate?.accountingTaxType ?? undefined,
          })),
        },
      })
    } catch { /* Accounting queue errors should never block the main flow */ }

    // Queue sub-ledger reversal journals based on state
    // Scenario 1: paidAt set but revenueDeferredDate NULL → no journals to reverse
    // Scenario 2: revenueDeferredDate set, inventoryAllocatedDate NULL (backorder) → reverse unearned revenue only
    // Scenario 3: inventoryAllocatedDate set, no shipments journaled → reverse unearned revenue + inventory allocation
    // Scenario 4: shipments journaled → reverse COGS for shipped portion + unearned for unshipped portion
    try {
      const settings = await getAccountingSettings()
      const orderRef = so.orderNumber ?? so.wcOrderNumber ?? orderId.slice(0, 8)

      if (so.revenueDeferredDate) {
        const refundRevenue = Math.round(totalGbp * 100) / 100
        const orderAccounting = await db.salesOrder.findUnique({
          where: { id: orderId },
          select: {
            lines: {
              select: {
                id: true,
                productId: true,
                description: true,
                qty: true,
                totalGbp: true,
              },
            },
            shipments: {
              where: { shipmentJournalDate: { not: null } },
              select: {
                revenueRecognizedAmount: true,
                cogsBatchAmount: true,
                lines: {
                  select: {
                    lineId: true,
                    qty: true,
                  },
                },
              },
            },
          },
        })

        const priorReversals = await db.accountingSyncLog.findMany({
          where: {
            referenceType: 'SalesOrder',
            referenceId: orderId,
            type: { in: ['COGS_REVERSAL', 'UNEARNED_REV_REVERSAL'] },
            status: { in: ['PENDING', 'SYNCED'] },
          },
          select: { type: true, payload: true },
        })

        const extractPayloadAmount = (
          payload: unknown,
          accountCode: string,
        ): number => {
          const linesPayload = (payload as { lines?: Array<{ accountCode?: string; debit?: number; credit?: number }> } | null)?.lines
          if (!Array.isArray(linesPayload)) return 0
          return linesPayload.reduce((sum, line) => (
            line.accountCode === accountCode ? sum + Number(line.debit ?? 0) : sum
          ), 0)
        }

        const priorCogsReversed = priorReversals
          .filter((row) => row.type === 'COGS_REVERSAL')
          .reduce((sum, row) => sum + extractPayloadAmount(row.payload, settings.inventoryAccount), 0)
        const priorUnearnedReversed = priorReversals
          .filter((row) => row.type === 'UNEARNED_REV_REVERSAL')
          .reduce((sum, row) => sum + extractPayloadAmount(row.payload, settings.unearnedRevenueAccount), 0)
        const priorAllocationReversed = priorReversals
          .filter((row) => row.type === 'UNEARNED_REV_REVERSAL')
          .reduce((sum, row) => sum + extractPayloadAmount(row.payload, settings.inventoryAccount), 0)

        const lineContexts = (orderAccounting?.lines ?? []).map((line) => ({
          id: line.id,
          productId: line.productId,
          description: line.description,
          qty: Number(line.qty),
          totalGbp: Number(line.totalGbp),
        }))

        const shippedQtyByLine = new Map<string, number>()
        let totalRecognized = 0
        let totalShippedCogs = 0

        for (const shipment of orderAccounting?.shipments ?? []) {
          totalRecognized += Number(shipment.revenueRecognizedAmount ?? 0)
          totalShippedCogs += Number(shipment.cogsBatchAmount ?? 0)
          for (const line of shipment.lines) {
            shippedQtyByLine.set(
              line.lineId,
              (shippedQtyByLine.get(line.lineId) ?? 0) + Number(line.qty),
            )
          }
        }

        const remainingShippedQtyByLine = new Map<string, number>()
        const remainingUnshippedQtyByLine = new Map<string, number>()
        let shippedProductRevenueBase = 0
        let unshippedProductRevenueBase = 0

        for (const line of lineContexts) {
          const shippedQty = Math.min(line.qty, shippedQtyByLine.get(line.id) ?? 0)
          const unshippedQty = Math.max(0, line.qty - shippedQty)
          remainingShippedQtyByLine.set(line.id, shippedQty)
          remainingUnshippedQtyByLine.set(line.id, unshippedQty)
          if (line.qty > 0) {
            shippedProductRevenueBase += (line.totalGbp * shippedQty) / line.qty
            unshippedProductRevenueBase += (line.totalGbp * unshippedQty) / line.qty
          }
        }

        let shippedQtyRevenue = 0
        let unshippedQtyRevenue = 0
        let nonQtyRevenue = 0

        for (const refundLine of refundLines) {
          if (!refundLine.productId || refundLine.qty <= 0) {
            nonQtyRevenue += refundLine.totalGbp
            continue
          }

          let remainingQty = refundLine.qty
          let assignedRevenue = 0
          const matchingLines = lineContexts.filter((line) => line.productId === refundLine.productId)

          for (const line of matchingLines) {
            if (remainingQty <= 0 || line.qty <= 0) break

            const unitRevenue = line.totalGbp / line.qty
            const shippedQtyAvailable = remainingShippedQtyByLine.get(line.id) ?? 0
            const shippedTake = Math.min(remainingQty, shippedQtyAvailable)
            if (shippedTake > 0) {
              shippedQtyRevenue += unitRevenue * shippedTake
              assignedRevenue += unitRevenue * shippedTake
              remainingQty -= shippedTake
              remainingShippedQtyByLine.set(line.id, shippedQtyAvailable - shippedTake)
            }

            const unshippedQtyAvailable = remainingUnshippedQtyByLine.get(line.id) ?? 0
            const unshippedTake = Math.min(remainingQty, unshippedQtyAvailable)
            if (unshippedTake > 0) {
              unshippedQtyRevenue += unitRevenue * unshippedTake
              assignedRevenue += unitRevenue * unshippedTake
              remainingQty -= unshippedTake
              remainingUnshippedQtyByLine.set(line.id, unshippedQtyAvailable - unshippedTake)
            }
          }

          nonQtyRevenue += Math.max(0, refundLine.totalGbp - assignedRevenue)
        }

        const componentTotal = shippedQtyRevenue + unshippedQtyRevenue + nonQtyRevenue
        const roundingDelta = Math.round((refundRevenue - componentTotal) * 100) / 100
        if (roundingDelta > 0) {
          nonQtyRevenue += roundingDelta
        }

        const remainingShippedCogs = Math.round(Math.max(0, totalShippedCogs - priorCogsReversed) * 100) / 100
        const remainingUnearned = Math.round(Math.max(
          0,
          Number(so.unearnedRevenueAmount ?? 0) - totalRecognized - priorUnearnedReversed,
        ) * 100) / 100
        const remainingAllocated = Math.round(Math.max(
          0,
          Number(so.allocationBatchAmount ?? 0) - totalShippedCogs - priorAllocationReversed,
        ) * 100) / 100

        const cogsReversal = shippedProductRevenueBase > 0
          ? Math.min(
              remainingShippedCogs,
              Math.round((remainingShippedCogs * (shippedQtyRevenue / shippedProductRevenueBase)) * 100) / 100,
            )
          : 0

        const unearnedReversal = Math.min(
          remainingUnearned,
          Math.round((unshippedQtyRevenue + nonQtyRevenue) * 100) / 100,
        )

        const allocationReversal = unshippedProductRevenueBase > 0
          ? Math.min(
              remainingAllocated,
              Math.round((remainingAllocated * (unshippedQtyRevenue / unshippedProductRevenueBase)) * 100) / 100,
            )
          : 0

        if (cogsReversal > 0) {
          await queueAccountingSync({
            type: 'COGS_REVERSAL',
            referenceType: 'SalesOrder',
            referenceId: orderId,
            payload: {
              date: new Date().toISOString().slice(0, 10),
              reference: `COGS reversal: ${orderRef}`,
              narration: `COGS reversal — refund on order ${orderRef}`,
              lines: [
                { accountCode: settings.inventoryAccount, description: `COGS reversal: ${orderRef}`, debit: cogsReversal },
                { accountCode: settings.cogsAccount, description: `COGS reversal: ${orderRef}`, credit: cogsReversal },
              ],
            },
          })
        }

        const journalLines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }> = []
        if (unearnedReversal > 0) {
          journalLines.push(
            { accountCode: settings.unearnedRevenueAccount, description: `Unearned revenue reversal: ${orderRef}`, debit: unearnedReversal },
            { accountCode: settings.salesAccount, description: `Unearned revenue reversal: ${orderRef}`, credit: unearnedReversal },
          )
        }
        if (allocationReversal > 0) {
          journalLines.push(
            { accountCode: settings.inventoryAccount, description: `Allocation reversal: ${orderRef}`, debit: allocationReversal },
            { accountCode: settings.allocatedInventoryAccount, description: `Allocation reversal: ${orderRef}`, credit: allocationReversal },
          )
        }

        if (journalLines.length > 0) {
          const hasInventoryReversal = allocationReversal > 0
          await queueAccountingSync({
            type: 'UNEARNED_REV_REVERSAL',
            referenceType: 'SalesOrder',
            referenceId: orderId,
            payload: {
              date: new Date().toISOString().slice(0, 10),
              reference: `Unearned reversal: ${orderRef}`,
              narration: hasInventoryReversal
                ? `Unearned revenue + allocation reversal — refund on order ${orderRef}`
                : `Unearned revenue reversal — refund on order ${orderRef}`,
              lines: journalLines,
            },
          })
        }
      }
      // Scenario 1: no revenueDeferredDate → no sub-ledger journals to reverse
    } catch { /* Accounting queue errors should never block the main flow */ }

    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'refunded',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to create refund: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Clone, Delete, Mark Paid, Update Notes
// ---------------------------------------------------------------------------

export async function cloneSalesOrder(id: string): Promise<{ success: boolean; newId?: string; error?: string }> {
  try {
    await requirePermission('sales.create')
    const so = await db.salesOrder.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!so) return { success: false, error: 'Order not found' }

    const ref = `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const clone = await db.salesOrder.create({
      data: {
        orderNumber: ref,
        status: 'DRAFT',
        currency: so.currency,
        fxRateToGbp: so.fxRateToGbp,
        customerId: so.customerId,
        customerName: so.customerName,
        customerEmail: so.customerEmail,
        billingAddress: so.billingAddress ?? undefined,
        shippingAddress: so.shippingAddress ?? undefined,
        subtotalForeign: so.subtotalForeign,
        shippingService: so.shippingService,
        shippingForeign: so.shippingForeign,
        taxForeign: so.taxForeign,
        totalForeign: so.totalForeign,
        subtotalGbp: so.subtotalGbp,
        shippingGbp: so.shippingGbp,
        taxGbp: so.taxGbp,
        totalGbp: so.totalGbp,
        shipFromWarehouseId: so.shipFromWarehouseId,
        salesRep: so.salesRep,
        discountStr: so.discountStr,
        discountAmount: so.discountAmount,
        taxRateName: so.taxRateName,
        taxRatePercent: so.taxRatePercent,
        notes: so.notes,
        internalNotes: so.internalNotes,
        lines: {
          create: so.lines.map((l) => ({
            productId: l.productId,
            sku: l.sku,
            description: l.description,
            qty: l.qty,
            unitPriceForeign: l.unitPriceForeign,
            unitPriceGbp: l.unitPriceGbp,
            discountStr: l.discountStr,
            discountAmount: l.discountAmount,
            taxRateId: l.taxRateId,
            taxForeign: l.taxForeign,
            taxGbp: l.taxGbp,
            totalForeign: l.totalForeign,
            totalGbp: l.totalGbp,
          })),
        },
      },
    })

    // Auto-allocate stock for cloned order
    const { autoAllocateOrder } = await import('./allocation')
    await autoAllocateOrder(clone.id)

    revalidatePath('/sales')
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: clone.id,
      action: 'cloned',
      tag: 'sales',
      level: 'INFO',
      description: `Cloned sales order ${so.orderNumber ?? so.wcOrderNumber}`,
      metadata: { sourceOrderId: id, sourceOrderNumber: so.orderNumber ?? so.wcOrderNumber, newOrderNumber: ref },
    })
    return { success: true, newId: clone.id }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'cloned',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to clone sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function deleteSalesOrder(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.create')
    const so = await db.salesOrder.findUnique({
      where: { id },
      select: { orderNumber: true, wcOrderNumber: true, status: true, shipFromWarehouseId: true, lines: { select: { productId: true, qty: true } }, _count: { select: { refunds: true, payments: true } } },
    })
    if (!so) return { success: false, error: 'Order not found' }
    if (!['DRAFT', 'PENDING_PAYMENT', 'ALLOCATED'].includes(so.status)) return { success: false, error: 'Only draft, pending payment, or allocated orders can be deleted' }
    if (so._count.refunds > 0 || so._count.payments > 0) return { success: false, error: 'Cannot delete an order with refunds or payments' }

    // Release allocations
    const { deallocateOrder } = await import('./allocation')
    await deallocateOrder(id)

    await db.salesOrderLine.deleteMany({ where: { orderId: id } })
    await db.salesOrder.delete({ where: { id } })
    revalidatePath('/sales')
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted sales order ${so.orderNumber ?? so.wcOrderNumber}`,
      metadata: { orderNumber: so.orderNumber ?? so.wcOrderNumber },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'deleted',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to delete sales order: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function markSalesOrderPaid(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.refund')
    const so = await db.salesOrder.findUnique({ where: { id }, select: { orderNumber: true, wcOrderNumber: true, paidAt: true, invoiceNumber: true } })
    if (!so) return { success: false, error: 'Order not found' }

    const markingAsPaid = !so.paidAt // transitioning from unpaid to paid
    await db.salesOrder.update({
      where: { id },
      data: { paidAt: markingAsPaid ? new Date() : null },
    })

    // Only auto-generate invoice when transitioning TO paid (not when toggling off).
    // Skip its own log — the 'paid' entry below covers both actions.
    if (markingAsPaid && !so.invoiceNumber) {
      const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
      if (trigger?.value === 'on_paid') {
        await generateInvoiceNumber(id, { skipLog: true })
      }
    }

    revalidatePath('/sales')
    revalidatePath(`/sales/${id}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'paid',
      tag: 'sales',
      level: 'INFO',
      description: `Marked sales order ${so.orderNumber ?? so.wcOrderNumber} as paid`,
      metadata: { orderNumber: so.orderNumber ?? so.wcOrderNumber, markingAsPaid },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'paid',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to mark sales order as paid: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function updateSalesOrderNotes(
  id: string,
  notes: string,
  internalNotes: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.create')
    const so = await db.salesOrder.update({
      where: { id },
      data: { notes: notes || null, internalNotes: internalNotes || null },
      select: { orderNumber: true, wcOrderNumber: true },
    })
    revalidatePath(`/sales/${id}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'sales',
      level: 'INFO',
      description: `Updated notes for order ${so.orderNumber ?? so.wcOrderNumber}`,
      metadata: { orderNumber: so.orderNumber ?? so.wcOrderNumber },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'updated',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to update sales order notes: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function generateInvoiceNumber(id: string, options?: { skipLog?: boolean }): Promise<{ success: boolean; invoiceNumber?: string; error?: string }> {
  try {
    await requirePermission('sales.process')
    // Use a transaction to prevent race conditions on invoice numbering
    const result = await db.$transaction(async (tx) => {
      const so = await tx.salesOrder.findUnique({ where: { id }, select: { wcOrderNumber: true, orderNumber: true, invoiceNumber: true } })
      if (!so) throw new Error('Order not found')
      if (so.invoiceNumber) return { invoiceNumber: so.invoiceNumber, orderNumber: so.orderNumber ?? so.wcOrderNumber }
      const count = await tx.salesOrder.count({ where: { invoiceNumber: { not: null } } })
      const invNum = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`
      await tx.salesOrder.update({ where: { id }, data: { invoiceNumber: invNum, invoicedAt: new Date() } })
      return { invoiceNumber: invNum, orderNumber: so.orderNumber ?? so.wcOrderNumber }
    })
    revalidatePath(`/sales/${id}`)
    if (!options?.skipLog) {
      await logActivity({
        entityType: 'SALES_ORDER',
        entityId: id,
        action: 'invoice_generated',
        tag: 'sales',
        level: 'INFO',
        description: `Generated invoice number for order ${result.orderNumber}`,
        metadata: { orderNumber: result.orderNumber, invoiceNumber: result.invoiceNumber },
      })
    }

    // Note: Accounting invoice is now created at order creation time (not here)

    return { success: true, invoiceNumber: result.invoiceNumber }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: id,
      action: 'invoice_generated',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to generate invoice number: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentRow = {
  id: string
  refundId: string | null
  creditNoteNumber: string | null
  amount: number
  currency: string
  method: string | null
  reference: string | null
  notes: string | null
  paidAt: string
}

export async function addPayment(input: {
  orderId: string
  refundId?: string
  amount: number
  currency: string
  method?: string
  reference?: string
  notes?: string
  paidAt?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.refund')
    if (!input.amount || input.amount <= 0) return { success: false, error: 'Amount must be greater than 0' }
    await db.payment.create({
      data: {
        orderId: input.orderId,
        refundId: input.refundId || null,
        amount: input.amount,
        currency: input.currency,
        method: input.method || null,
        reference: input.reference || null,
        notes: input.notes || null,
        paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      },
    })

    // Auto-set paidAt on the order if invoice total is fully paid
    const so = await db.salesOrder.findUnique({
      where: { id: input.orderId },
      select: { orderNumber: true, wcOrderNumber: true, totalGbp: true, paidAt: true },
    })
    if (so && !so.paidAt) {
      const payments = await db.payment.findMany({
        where: { orderId: input.orderId, refundId: null },
        select: { amount: true },
      })
      const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0)
      if (totalPaid >= Number(so.totalGbp)) {
        await db.salesOrder.update({ where: { id: input.orderId }, data: { paidAt: new Date() } })

        // Auto-generate invoice if trigger is on_paid (skip its own log —
        // the payment_added entry below covers both actions)
        const trigger = await db.setting.findUnique({ where: { key: 'invoice_trigger' } })
        if (trigger?.value === 'on_paid') {
          await generateInvoiceNumber(input.orderId, { skipLog: true })
        }
      }
    }

    revalidatePath(`/sales/${input.orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'payment_added',
      tag: 'sales',
      level: 'INFO',
      description: `Added £${input.amount.toFixed(2)} payment to order ${so?.orderNumber ?? so?.wcOrderNumber ?? input.orderId}`,
      metadata: { orderNumber: so?.orderNumber ?? so?.wcOrderNumber, amount: input.amount, currency: input.currency, method: input.method },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'payment_added',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to add payment: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}

export async function deletePayment(paymentId: string, orderId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await requirePermission('sales.refund')
    await db.payment.delete({ where: { id: paymentId } })
    const so = await db.salesOrder.findUnique({ where: { id: orderId }, select: { orderNumber: true, wcOrderNumber: true } })
    revalidatePath(`/sales/${orderId}`)
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'INFO',
      description: `Deleted payment from order ${so?.orderNumber ?? so?.wcOrderNumber ?? orderId}`,
      metadata: { orderNumber: so?.orderNumber ?? so?.wcOrderNumber, paymentId },
    })
    return { success: true }
  } catch (e) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: 'payment_deleted',
      tag: 'sales',
      level: 'ERROR',
      description: `Failed to delete payment: ${String(e)}`,
      metadata: null,
    })
    return { success: false, error: String(e) }
  }
}
