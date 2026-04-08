'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'
import { requireAuth } from '@/lib/auth/server'

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
  _count: { salesOrders: number }
}): CustomerRow {
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
  }
}

export async function getCustomers(activeOnly = true): Promise<CustomerRow[]> {
  await requireAuth()
  const rows = await db.customer.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    include: { _count: { select: { salesOrders: true } } },
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

export async function createCustomer(input: CustomerInput): Promise<{ success: boolean; customer?: CustomerRow; error?: string }> {
  await requireAuth()
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
  await requireAuth()
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
  await requireAuth()
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
