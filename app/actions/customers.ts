'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'

export type AddressData = {
  line1?: string
  line2?: string
  city?: string
  county?: string
  postcode?: string
  country?: string
}

export type CustomerRow = {
  id: string
  firstName: string
  lastName: string
  fullName: string
  email: string | null
  phone: string | null
  company: string | null
  taxNumber: string | null
  billingAddress: AddressData | null
  shippingAddress: AddressData | null
  notes: string | null
  active: boolean
  orderCount: number
  lifetimeValueGbp: number
  currentYearSalesGbp: number
  lastOrderAt: string | null
  createdAt: string
  gdprAnonymisedAt: string | null
}

export type CustomerInput = {
  firstName: string
  lastName?: string
  email?: string
  phone?: string
  company?: string
  taxNumber?: string
  billingAddress?: AddressData
  shippingAddress?: AddressData
  notes?: string
}

const REVENUE_STATUSES = new Set(['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'])

function mapCustomer(c: {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  company: string | null
  taxNumber: string | null
  billingAddress: unknown
  shippingAddress: unknown
  notes: string | null
  active: boolean
  createdAt: Date
  gdprAnonymisedAt: Date | null
  _count: { salesOrders: number }
  salesOrders?: { status: string; totalGbp: unknown; createdAt: Date }[]
}): CustomerRow {
  const currentYear = new Date().getFullYear()
  const revenueOrders = (c.salesOrders ?? []).filter((o) => REVENUE_STATUSES.has(o.status))
  const lastOrder = c.salesOrders?.length
    ? c.salesOrders.reduce((latest, o) => (o.createdAt > latest ? o.createdAt : latest), c.salesOrders[0].createdAt)
    : null

  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    fullName: [c.firstName, c.lastName].filter(Boolean).join(' '),
    email: c.email,
    phone: c.phone,
    company: c.company,
    taxNumber: c.taxNumber,
    billingAddress: c.billingAddress as AddressData | null,
    shippingAddress: c.shippingAddress as AddressData | null,
    notes: c.notes,
    active: c.active,
    orderCount: c._count.salesOrders,
    lifetimeValueGbp: revenueOrders.reduce((sum, o) => sum + Number(o.totalGbp), 0),
    currentYearSalesGbp: revenueOrders
      .filter((o) => o.createdAt.getFullYear() === currentYear)
      .reduce((sum, o) => sum + Number(o.totalGbp), 0),
    lastOrderAt: lastOrder?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    gdprAnonymisedAt: c.gdprAnonymisedAt?.toISOString() ?? null,
  }
}

export async function getCustomers(activeOnly = true): Promise<CustomerRow[]> {
  await requireAuth()
  const rows = await db.customer.findMany({
    where: {
      archived: { not: true },
      ...(activeOnly ? { active: true } : {}),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    include: {
      _count: { select: { salesOrders: true } },
      salesOrders: {
        select: { status: true, totalGbp: true, createdAt: true },
      },
    },
  })
  return rows.map(mapCustomer)
}

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  await requireAuth()
  const c = await db.customer.findUnique({
    where: { id },
    include: { _count: { select: { salesOrders: true } } },
  })
  return c ? mapCustomer(c) : null
}

export type CustomerOrderRow = {
  id: string
  orderNumber: string | null
  status: string
  currency: string
  totalForeign: number
  totalGbp: number
  createdAt: string
  lineCount: number
}

export type CustomerDetail = CustomerRow & {
  orders: CustomerOrderRow[]
  totalTurnoverGbp: number
  annualTurnoverGbp: Record<string, number>
}

export async function getCustomerDetail(id: string): Promise<CustomerDetail | null> {
  await requireAuth()
  const c = await db.customer.findUnique({
    where: { id },
    include: {
      _count: { select: { salesOrders: true } },
      salesOrders: {
        select: {
          id: true,
          orderNumber: true,
          wcOrderNumber: true,
          status: true,
          currency: true,
          totalForeign: true,
          totalGbp: true,
          createdAt: true,
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!c) return null

  const orders: CustomerOrderRow[] = c.salesOrders.map((so) => ({
    id: so.id,
    orderNumber: so.orderNumber ?? so.wcOrderNumber ?? so.id.slice(0, 8),
    status: so.status,
    currency: so.currency,
    totalForeign: Number(so.totalForeign),
    totalGbp: Number(so.totalGbp),
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
  }))

  // Exclude cancelled/refunded from turnover calculations
  const REVENUE_STATUSES = new Set(['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'])
  const revenueOrders = orders.filter((o) => REVENUE_STATUSES.has(o.status))

  const totalTurnoverGbp = revenueOrders.reduce((sum, o) => sum + o.totalGbp, 0)

  const annualTurnoverGbp: Record<string, number> = {}
  for (const o of revenueOrders) {
    const year = new Date(o.createdAt).getFullYear().toString()
    annualTurnoverGbp[year] = (annualTurnoverGbp[year] ?? 0) + o.totalGbp
  }

  return {
    ...mapCustomer(c),
    orders,
    totalTurnoverGbp,
    annualTurnoverGbp,
  }
}

export async function createCustomer(input: CustomerInput): Promise<{ success: boolean; customer?: CustomerRow; error?: string }> {
  await requirePermission('sales.create')
  try {
    if (!input.firstName?.trim()) return { success: false, error: 'First name is required' }
    const c = await db.customer.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName || '',
        email: input.email || null,
        phone: input.phone || null,
        company: input.company || null,
        taxNumber: input.taxNumber || null,
        billingAddress: input.billingAddress ?? Prisma.JsonNull,
        shippingAddress: input.shippingAddress ?? Prisma.JsonNull,
        notes: input.notes || null,
      },
      include: { _count: { select: { salesOrders: true } } },
    })
    revalidatePath('/sales/contacts')
    revalidatePath('/sales')
    logActivity({ entityType: 'CUSTOMER', entityId: c.id, tag: 'sales', action: 'created', description: `Created customer: ${[input.firstName, input.lastName].filter(Boolean).join(' ')}` })
    return { success: true, customer: mapCustomer(c) }
  } catch (e) {
    logActivity({ entityType: 'CUSTOMER', tag: 'sales', action: 'created', level: 'ERROR', description: `Failed to create customer: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function updateCustomer(id: string, input: Partial<CustomerInput> & { active?: boolean }): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sales.create')
  try {
    await db.customer.update({
      where: { id },
      data: {
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName || '' }),
        ...(input.email !== undefined && { email: input.email || null }),
        ...(input.phone !== undefined && { phone: input.phone || null }),
        ...(input.company !== undefined && { company: input.company || null }),
        ...(input.taxNumber !== undefined && { taxNumber: input.taxNumber || null }),
        ...(input.billingAddress !== undefined && { billingAddress: input.billingAddress ?? Prisma.JsonNull }),
        ...(input.shippingAddress !== undefined && { shippingAddress: input.shippingAddress ?? Prisma.JsonNull }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
    })
    revalidatePath('/sales/contacts')
    revalidatePath('/sales')
    logActivity({ entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', description: `Updated customer: ${input.firstName ?? ''}${input.lastName ? ' ' + input.lastName : ''}`.trim() })
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', level: 'ERROR', description: `Failed to update customer: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importContactsCsv(formData: FormData): Promise<{ success?: boolean; count?: number; error?: string }> {
  await requirePermission('sales.create')
  try {
    const file = formData.get('file') as File
    if (!file) return { error: 'No file' }
    const text = await file.text()
    const rows = parseCsv(text)
    let count = 0
    for (const r of rows) {
      const firstName = r.firstName || r.firstname || r['first name'] || ''
      if (!firstName) continue
      await db.customer.create({
        data: {
          firstName,
          lastName: r.lastName || r.lastname || r['last name'] || '',
          email: r.email || null,
          phone: r.phone || null,
          company: r.company || null,
          taxNumber: r.taxNumber || r.taxnumber || r['tax number'] || null,
          billingAddress: { line1: r.billing_line1, line2: r.billing_line2, city: r.billing_city, county: r.billing_county, postcode: r.billing_postcode, country: r.billing_country },
          shippingAddress: { line1: r.shipping_line1, line2: r.shipping_line2, city: r.shipping_city, county: r.shipping_county, postcode: r.shipping_postcode, country: r.shipping_country },
          notes: r.notes || null,
        },
      })
      count++
    }
    revalidatePath('/sales/contacts')
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${count} contacts from CSV` })
    return { success: true, count }
  } catch (e) {
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import contacts from CSV: ${String(e)}` })
    return { error: String(e) }
  }
}

export async function anonymiseCustomer(customerId: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sync')
  try {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      include: { salesOrders: { select: { id: true } } },
    })
    if (!customer) return { success: false, error: 'Customer not found' }
    if (customer.gdprAnonymisedAt) return { success: false, error: 'Customer already anonymised' }

    const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ')

    // Anonymise customer record
    await db.customer.update({
      where: { id: customerId },
      data: {
        firstName: 'GDPR',
        lastName: 'Anonymised',
        email: null,
        phone: null,
        company: null,
        taxNumber: null,
        billingAddress: Prisma.JsonNull,
        shippingAddress: Prisma.JsonNull,
        notes: null,
        wcCustomerId: null,
        active: false,
        gdprAnonymisedAt: new Date(),
      },
    })

    // Anonymise linked sales orders
    if (customer.salesOrders.length > 0) {
      await db.salesOrder.updateMany({
        where: { customerId },
        data: {
          customerName: 'GDPR Anonymised',
          customerEmail: null,
          billingAddress: Prisma.JsonNull,
          shippingAddress: Prisma.JsonNull,
          notes: null,
        },
      })
    }

    logActivity({
      entityType: 'CUSTOMER',
      entityId: customerId,
      tag: 'sales',
      action: 'gdpr_anonymised',
      description: `GDPR anonymised customer: ${customerName} (${customer.salesOrders.length} orders anonymised)`,
    })

    revalidatePath('/sales/contacts')
    return { success: true }
  } catch (e) {
    logActivity({
      entityType: 'CUSTOMER',
      entityId: customerId,
      tag: 'sales',
      action: 'gdpr_anonymised',
      level: 'ERROR',
      description: `Failed to GDPR anonymise customer: ${String(e)}`,
    })
    return { success: false, error: String(e) }
  }
}
