'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import {
  createCsvImportExecutionResult,
  createCsvImportPreviewResult,
  getCsvImportMode,
  type CsvImportActionResult,
} from '@/lib/csv-import'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const MAX_IMPORT_ROWS = 10_000

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
  lifetimeValueBase: number
  currentYearSalesBase: number
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

function hasCsvValue(row: Record<string, string>, key: string): boolean {
  return typeof row[key] === 'string' && row[key].trim().length > 0
}

function mergeImportedAddress(
  row: Record<string, string>,
  prefix: 'billing' | 'shipping',
  existing: AddressData | null | undefined,
): AddressData | undefined {
  const merged: AddressData = { ...(existing ?? {}) }
  let touched = false
  for (const field of ['line1', 'line2', 'city', 'county', 'postcode', 'country'] as const) {
    const key = `${prefix}_${field}`
    if (hasCsvValue(row, key)) {
      merged[field] = row[key].trim()
      touched = true
    }
  }
  return touched ? merged : undefined
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
  salesOrders?: { status: string; totalBase: unknown; createdAt: Date }[]
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
    lifetimeValueBase: revenueOrders.reduce((sum, o) => sum + Number(o.totalBase), 0),
    currentYearSalesBase: revenueOrders
      .filter((o) => o.createdAt.getFullYear() === currentYear)
      .reduce((sum, o) => sum + Number(o.totalBase), 0),
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
        select: { status: true, totalBase: true, createdAt: true },
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
  totalBase: number
  createdAt: string
  lineCount: number
}

export type CustomerDetail = CustomerRow & {
  orders: CustomerOrderRow[]
  totalTurnoverBase: number
  annualTurnoverBase: Record<string, number>
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
          externalOrderNumber: true,
          status: true,
          currency: true,
          totalForeign: true,
          totalBase: true,
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
    orderNumber: so.orderNumber ?? so.externalOrderNumber ?? so.id.slice(0, 8),
    status: so.status,
    currency: so.currency,
    totalForeign: Number(so.totalForeign),
    totalBase: Number(so.totalBase),
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
  }))

  // Exclude cancelled/refunded from turnover calculations
  const REVENUE_STATUSES = new Set(['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING', 'SHIPPED', 'COMPLETED', 'DELIVERED', 'PARTIALLY_REFUNDED'])
  const revenueOrders = orders.filter((o) => REVENUE_STATUSES.has(o.status))

  const totalTurnoverBase = revenueOrders.reduce((sum, o) => sum + o.totalBase, 0)

  const annualTurnoverBase: Record<string, number> = {}
  for (const o of revenueOrders) {
    const year = new Date(o.createdAt).getFullYear().toString()
    annualTurnoverBase[year] = (annualTurnoverBase[year] ?? 0) + o.totalBase
  }

  return {
    ...mapCustomer(c),
    orders,
    totalTurnoverBase,
    annualTurnoverBase,
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
    await logActivity({ entityType: 'CUSTOMER', entityId: c.id, tag: 'sales', action: 'created', description: `Created customer: ${[input.firstName, input.lastName].filter(Boolean).join(' ')}` })
    return { success: true, customer: mapCustomer(c) }
  } catch (e) {
    await logActivity({ entityType: 'CUSTOMER', tag: 'sales', action: 'created', level: 'ERROR', description: `Failed to create customer: ${String(e)}` })
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
    await logActivity({ entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', description: `Updated customer: ${input.firstName ?? ''}${input.lastName ? ' ' + input.lastName : ''}`.trim() })
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', level: 'ERROR', description: `Failed to update customer: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importContactsCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = mode === 'preview'
  await requirePermission('sales.create')
  try {
    const file = formData.get('file') as File
    if (!file) {
      return preview
        ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: ['No file'], error: 'No file' })
        : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: ['No file'], error: 'No file', success: false })
    }
    if (file.size > MAX_IMPORT_BYTES) {
      const error = `File exceeds maximum size (${MAX_IMPORT_BYTES / (1024 * 1024)} MB)`
      return preview
        ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
        : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
    }
    const text = await file.text()
    const parsed = parseCsv(text)
    const rows = parsed.slice(0, MAX_IMPORT_ROWS)
    const dropped = parsed.length - rows.length
    const customers = await db.customer.findMany({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        company: true,
        billingAddress: true,
        shippingAddress: true,
      },
    })
    const byId = new Map(customers.map((customer) => [customer.id, customer]))
    const byEmail = new Map<string, typeof customers>()
    const byIdentity = new Map<string, typeof customers>()
    for (const customer of customers) {
      if (customer.email) {
        const key = customer.email.trim().toLowerCase()
        byEmail.set(key, [...(byEmail.get(key) ?? []), customer])
      }
      const identityKey = [customer.firstName, customer.lastName, customer.company ?? '']
        .map((part) => part.trim().toLowerCase())
        .join('|')
      byIdentity.set(identityKey, [...(byIdentity.get(identityKey) ?? []), customer])
    }

    let created = 0
    let updated = 0
    let skipped = 0
    const errors: string[] = []
    if (dropped > 0) {
      errors.push(`File has more than ${MAX_IMPORT_ROWS} rows — ${dropped} row(s) skipped`)
    }

    for (let index = 0; index < rows.length; index++) {
      const r = rows[index]
      const lineNum = index + 2
      const customerId = r.customerId?.trim() || ''
      const firstName = (r.firstName || r.firstname || r['first name'] || '').trim()
      const lastName = (r.lastName || r.lastname || r['last name'] || '').trim()
      const email = (r.email || '').trim()
      const company = (r.company || '').trim()

      let existing = customerId ? (byId.get(customerId) ?? null) : null
      if (!existing && email) {
        const emailMatches = byEmail.get(email.toLowerCase()) ?? []
        if (emailMatches.length === 1) existing = emailMatches[0]
        else if (emailMatches.length > 1) {
          errors.push(`Row ${lineNum}: email "${email}" matches multiple contacts`)
          skipped++
          continue
        }
      }
      if (!existing) {
        const identityMatches = byIdentity.get([firstName, lastName, company].map((part) => part.toLowerCase()).join('|')) ?? []
        if (identityMatches.length === 1) existing = identityMatches[0]
        else if (identityMatches.length > 1) {
          errors.push(`Row ${lineNum}: contact name matches multiple records`)
          skipped++
          continue
        }
      }

      if (!firstName && !existing) {
        errors.push(`Row ${lineNum}: missing firstName or no existing contact match`)
        skipped++
        continue
      }

      try {
        if (existing) {
          const billingAddress = mergeImportedAddress(r, 'billing', existing.billingAddress as AddressData | null)
          const shippingAddress = mergeImportedAddress(r, 'shipping', existing.shippingAddress as AddressData | null)
          if (!preview) {
            await db.customer.update({
              where: { id: existing.id },
              data: {
                ...(firstName ? { firstName } : {}),
                ...(lastName ? { lastName } : {}),
                ...(email ? { email } : {}),
                ...(r.phone?.trim() ? { phone: r.phone.trim() } : {}),
                ...(company ? { company } : {}),
                ...(r.taxNumber?.trim() || r.taxnumber?.trim() || r['tax number']?.trim() ? { taxNumber: (r.taxNumber || r.taxnumber || r['tax number']).trim() } : {}),
                ...(billingAddress ? { billingAddress } : {}),
                ...(shippingAddress ? { shippingAddress } : {}),
                ...(r.notes?.trim() ? { notes: r.notes.trim() } : {}),
              },
            })
          }
          updated++
        } else {
          if (!preview) {
            await db.customer.create({
              data: {
                firstName,
                lastName,
                email: email || null,
                phone: r.phone?.trim() || null,
                company: company || null,
                taxNumber: (r.taxNumber || r.taxnumber || r['tax number'] || '').trim() || null,
                billingAddress: mergeImportedAddress(r, 'billing', null) ?? Prisma.JsonNull,
                shippingAddress: mergeImportedAddress(r, 'shipping', null) ?? Prisma.JsonNull,
                notes: r.notes?.trim() || null,
              },
            })
          }
          created++
        }
      } catch (error) {
        errors.push(`Row ${lineNum}: ${String(error)}`)
        skipped++
      }
    }
    if (preview) {
      return createCsvImportPreviewResult({
        totalRows: parsed.length,
        created,
        updated,
        errorCount: skipped + dropped,
        errors,
      })
    }
    revalidatePath('/sales/contacts')
    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: errors.length && created === 0 && updated === 0 ? 'ERROR' : (errors.length ? 'WARNING' : 'INFO'),
      description: errors.length
        ? `Imported ${created} contacts, updated ${updated} from CSV with warnings: ${errors[0]}`
        : `Imported ${created} contacts, updated ${updated} from CSV`,
    })
    return createCsvImportExecutionResult({
      created,
      updated,
      skipped,
      errors,
      error: created === 0 && updated === 0 && errors.length > 0 ? errors[0] : undefined,
    })
  } catch (e) {
    await logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import contacts from CSV: ${String(e)}` })
    const error = String(e)
    return preview
      ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
      : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
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
        externalCustomerId: null,
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

    await logActivity({
      entityType: 'CUSTOMER',
      entityId: customerId,
      tag: 'sales',
      action: 'gdpr_anonymised',
      description: `GDPR anonymised customer: ${customerName} (${customer.salesOrders.length} orders anonymised)`,
    })

    revalidatePath('/sales/contacts')
    return { success: true }
  } catch (e) {
    await logActivity({
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
