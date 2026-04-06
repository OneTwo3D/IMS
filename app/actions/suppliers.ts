'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'

export type SupplierRow = {
  id: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
  currency: string
  taxRateId: string | null
  taxRateName: string | null
  taxRate: number | null
  vatNumber: string | null
  accountNumber: string | null
  paymentTermsDays: number | null
  notes: string | null
  active: boolean
}

export type SupplierInput = {
  name: string
  contactName?: string
  email?: string
  phone?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  county?: string
  postcode?: string
  country?: string
  currency?: string
  taxRateId?: string | null
  vatNumber?: string
  accountNumber?: string
  paymentTermsDays?: number | null
  notes?: string
}

const SUPPLIER_SELECT = {
  id: true,
  name: true,
  contactName: true,
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
  currency: true,
  taxRateId: true,
  taxRate: { select: { id: true, name: true, rate: true } },
  vatNumber: true,
  accountNumber: true,
  paymentTermsDays: true,
  notes: true,
  active: true,
} as const

function mapSupplier(s: {
  id: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  county: string | null
  postcode: string | null
  country: string | null
  currency: string
  taxRateId: string | null
  taxRate: { id: string; name: string; rate: unknown } | null
  vatNumber: string | null
  accountNumber: string | null
  paymentTermsDays: number | null
  notes: string | null
  active: boolean
}): SupplierRow {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    email: s.email,
    phone: s.phone,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    county: s.county,
    postcode: s.postcode,
    country: s.country,
    currency: s.currency,
    taxRateId: s.taxRateId,
    taxRateName: s.taxRate?.name ?? null,
    taxRate: s.taxRate ? Number(s.taxRate.rate) : null,
    vatNumber: s.vatNumber,
    accountNumber: s.accountNumber,
    paymentTermsDays: s.paymentTermsDays,
    notes: s.notes,
    active: s.active,
  }
}

export async function getSuppliers(includeInactive = false): Promise<SupplierRow[]> {
  const rows = await db.supplier.findMany({
    where: includeInactive ? undefined : { active: true },
    select: SUPPLIER_SELECT,
    orderBy: { name: 'asc' },
  })
  return rows.map(mapSupplier)
}

export async function getSupplier(id: string): Promise<SupplierRow | null> {
  const s = await db.supplier.findUnique({ where: { id }, select: SUPPLIER_SELECT })
  return s ? mapSupplier(s) : null
}

export async function createSupplier(input: SupplierInput): Promise<{ success: boolean; supplier?: SupplierRow; error?: string }> {
  try {
    const s = await db.supplier.create({
      data: {
        name: input.name,
        contactName: input.contactName || null,
        email: input.email || null,
        phone: input.phone || null,
        addressLine1: input.addressLine1 || null,
        addressLine2: input.addressLine2 || null,
        city: input.city || null,
        county: input.county || null,
        postcode: input.postcode || null,
        country: input.country || null,
        currency: input.currency || 'GBP',
        taxRateId: input.taxRateId || null,
        vatNumber: input.vatNumber || null,
        accountNumber: input.accountNumber || null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        notes: input.notes || null,
      },
      select: SUPPLIER_SELECT,
    })
    revalidatePath('/purchase-orders')
    logActivity({ entityType: 'SUPPLIER', entityId: s.id, tag: 'purchase', action: 'created', description: `Created supplier: ${input.name}` })
    return { success: true, supplier: mapSupplier(s) }
  } catch (e) {
    logActivity({ entityType: 'SUPPLIER', tag: 'purchase', action: 'created', level: 'ERROR', description: `Failed to create supplier: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function updateSupplier(id: string, input: Partial<SupplierInput> & { active?: boolean }): Promise<{ success: boolean; supplier?: SupplierRow; error?: string }> {
  try {
    const s = await db.supplier.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.contactName !== undefined && { contactName: input.contactName || null }),
        ...(input.email !== undefined && { email: input.email || null }),
        ...(input.phone !== undefined && { phone: input.phone || null }),
        ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 || null }),
        ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 || null }),
        ...(input.city !== undefined && { city: input.city || null }),
        ...(input.county !== undefined && { county: input.county || null }),
        ...(input.postcode !== undefined && { postcode: input.postcode || null }),
        ...(input.country !== undefined && { country: input.country || null }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.taxRateId !== undefined && { taxRateId: input.taxRateId || null }),
        ...(input.vatNumber !== undefined && { vatNumber: input.vatNumber || null }),
        ...(input.accountNumber !== undefined && { accountNumber: input.accountNumber || null }),
        ...(input.paymentTermsDays !== undefined && { paymentTermsDays: input.paymentTermsDays ?? null }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
      select: SUPPLIER_SELECT,
    })
    revalidatePath('/purchase-orders')
    logActivity({ entityType: 'SUPPLIER', entityId: s.id, tag: 'purchase', action: 'updated', description: `Updated supplier: ${s.name}` })
    return { success: true, supplier: mapSupplier(s) }
  } catch (e) {
    logActivity({ entityType: 'SUPPLIER', entityId: id, tag: 'purchase', action: 'updated', level: 'ERROR', description: `Failed to update supplier: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importSuppliersCsv(formData: FormData): Promise<{ success?: boolean; count?: number; error?: string }> {
  try {
    const file = formData.get('file') as File
    if (!file) return { error: 'No file' }
    const rows = parseCsv(await file.text())
    let count = 0
    for (const r of rows) {
      const name = r.name || r.Name || ''
      if (!name) continue
      await db.supplier.create({
        data: {
          name, contactName: r.contactName || null, email: r.email || null, phone: r.phone || null,
          currency: r.currency || 'GBP', vatNumber: r.vatNumber || null, accountNumber: r.accountNumber || null,
          paymentTermsDays: r.paymentTermsDays ? parseInt(r.paymentTermsDays) : null,
          addressLine1: r.addressLine1 || null, addressLine2: r.addressLine2 || null,
          city: r.city || null, county: r.county || null, postcode: r.postcode || null, country: r.country || null,
          notes: r.notes || null,
        },
      })
      count++
    }
    revalidatePath('/purchase-orders/suppliers')
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', description: `Imported ${count} suppliers from CSV` })
    return { success: true, count }
  } catch (e) {
    logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import suppliers from CSV: ${String(e)}` })
    return { error: String(e) }
  }
}
