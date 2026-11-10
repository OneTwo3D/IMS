'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { parseCsv } from '@/lib/csv'
import { logActivity, logActivityInTransaction } from '@/lib/activity-log'
import { eraseCustomerPersonalData } from '@/lib/domain/erasure/erase-personal-data'
import { openWarehouseOrdersWarning } from '@/lib/domain/erasure/warehouse-obligations'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { orderTurnoverBase, REFUND_TURNOVER_SELECT } from '@/lib/domain/sales/customer-turnover'
import { toIsoCountryCode } from '@/lib/countries'
import {
  createCsvImportExecutionResult,
  createCsvImportPreviewResult,
  getCsvImportMode,
  isCsvImportDryRunMode,
  runCsvImportMutation,
  type CsvImportActionResult,
} from '@/lib/csv-import'

const ANONYMISED_CUSTOMER_REFUSAL = 'This customer has been anonymised and cannot be changed'
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
  /** False when some invoiced order has refunds on an unproven or mixed basis, so turnover is an upper bound. */
  lifetimeValueUpperBound: boolean
  /** True when an unplaced credit is zero or negative, so the figure could be higher or lower (shown as \u2248). */
  lifetimeValueIndeterminate: boolean
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
  if (merged.country) {
    merged.country = toIsoCountryCode(merged.country) ?? merged.country
  }
  return touched ? merged : undefined
}

function normalizeAddress(address: AddressData | null | undefined): AddressData | Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!address) return Prisma.JsonNull

  const normalized: AddressData = {}
  for (const [key, value] of Object.entries(address)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    if (key === 'country') {
      normalized.country = toIsoCountryCode(trimmed) ?? trimmed
      continue
    }
    normalized[key as keyof AddressData] = trimmed
  }

  return Object.keys(normalized).length > 0 ? normalized : Prisma.JsonNull
}

type TurnoverOrderInput = Parameters<typeof orderTurnoverBase>[0]

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
  salesOrders?: (TurnoverOrderInput & { createdAt: Date })[]
}): CustomerRow {
  const currentYear = new Date().getFullYear()
  // Turnover: the shared invoiced basis, refunds netted (customer-turnover.ts).
  const revenueOrders = (c.salesOrders ?? []).flatMap((o) => {
    const t = orderTurnoverBase(o)
    return t ? [{ createdAt: o.createdAt, value: t.value, bound: t.bound }] : []
  })
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
    lifetimeValueBase: revenueOrders.reduce((sum, o) => sum + o.value, 0),
    lifetimeValueUpperBound: revenueOrders.some((o) => o.bound === 'upper') && !revenueOrders.some((o) => o.bound === 'indeterminate'),
    lifetimeValueIndeterminate: revenueOrders.some((o) => o.bound === 'indeterminate'),
    currentYearSalesBase: revenueOrders
      .filter((o) => o.createdAt.getFullYear() === currentYear)
      .reduce((sum, o) => sum + o.value, 0),
    lastOrderAt: lastOrder?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    gdprAnonymisedAt: c.gdprAnonymisedAt?.toISOString() ?? null,
  }
}

export async function getCustomers(activeOnly = true): Promise<CustomerRow[]> {
  await requireInternalUser()
  const rows = await db.customer.findMany({
    where: {
      archived: { not: true },
      ...(activeOnly ? { active: true } : {}),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    include: {
      _count: { select: { salesOrders: true } },
      salesOrders: {
        select: {
          status: true, invoiceNumber: true, accountingInvoiceId: true, shoppingLinks: { select: { connector: true } }, totalBase: true, createdAt: true,
          refunds: REFUND_TURNOVER_SELECT,
        },
      },
    },
  })
  return rows.map(mapCustomer)
}

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  await requireInternalUser()
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
  refundStatus: string
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
  await requireInternalUser()
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
          refundStatus: true,
          invoiceNumber: true,
          accountingInvoiceId: true,
          shoppingLinks: { select: { connector: true } },
          refunds: REFUND_TURNOVER_SELECT,
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
    refundStatus: so.refundStatus,
    currency: so.currency,
    totalForeign: Number(so.totalForeign),
    totalBase: Number(so.totalBase),
    createdAt: so.createdAt.toISOString(),
    lineCount: so._count.lines,
  }))

  // Turnover: the shared invoiced basis with refunds netted (customer-turnover.ts); drafts, cancelled
  // and un-invoiced orders are listed above but do not count.
  let totalTurnoverBase = 0
  const annualTurnoverBase: Record<string, number> = {}
  for (const so of c.salesOrders) {
    const t = orderTurnoverBase(so)
    if (!t) continue
    totalTurnoverBase += t.value
    const year = so.createdAt.getFullYear().toString()
    annualTurnoverBase[year] = (annualTurnoverBase[year] ?? 0) + t.value
  }

  return {
    ...mapCustomer(c),
    orders,
    totalTurnoverBase,
    annualTurnoverBase,
  }
}

export async function createCustomer(input: CustomerInput): Promise<{ success: boolean; customer?: CustomerRow; error?: string }> {
  const session = await requirePermission('sales.create')
  try {
    if (!input.firstName?.trim()) return { success: false, error: 'First name is required' }
    // THE ROW AND ITS NAME-BEARING ACTIVITY RECORD COMMIT TOGETHER: an erasure that follows either finds both, and one that is
    // already running holds the customer lock this create has not yet been able to take (the row is new, so there is no race).
    const c = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName || '',
        email: input.email || null,
        phone: input.phone || null,
        company: input.company || null,
        taxNumber: input.taxNumber || null,
        billingAddress: normalizeAddress(input.billingAddress),
        shippingAddress: normalizeAddress(input.shippingAddress),
        notes: input.notes || null,
      },
      include: { _count: { select: { salesOrders: true } } },
      })
      await logActivityInTransaction(tx, { entityType: 'CUSTOMER', entityId: created.id, tag: 'sales', action: 'created', description: `Created customer: ${[input.firstName, input.lastName].filter(Boolean).join(' ')}`, userId: session.user.id ?? null })
      return created
    })
    revalidatePath('/sales/contacts')
    revalidatePath('/sales')
    return { success: true, customer: mapCustomer(c) }
  } catch (e) {
    await logActivity({ entityType: 'CUSTOMER', tag: 'sales', action: 'created', level: 'ERROR', description: `Failed to create customer: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function updateCustomer(id: string, input: Partial<CustomerInput> & { active?: boolean }): Promise<{ success: boolean; error?: string }> {
  const session = await requirePermission('sales.create')
  try {
    // CONDITIONAL WRITE: an anonymised customer is never written to, and the condition is part of the statement, so a
    // read that went stale between the page load and this save cannot slip through.
    // THE CONDITIONAL UPDATE AND THE NAME-BEARING ACTIVITY ROW COMMIT TOGETHER. The update takes the customer row lock and holds
    // it until the row exists, so an erasure either runs first (this updates nothing and writes nothing) or blocks on that lock
    // until the row is committed and then finds it, and scrubs it.
    const written = await db.$transaction(async (tx) => {
      const result = await tx.customer.updateMany({
      where: { id, gdprAnonymisedAt: null },
      data: {
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName || '' }),
        ...(input.email !== undefined && { email: input.email || null }),
        ...(input.phone !== undefined && { phone: input.phone || null }),
        ...(input.company !== undefined && { company: input.company || null }),
        ...(input.taxNumber !== undefined && { taxNumber: input.taxNumber || null }),
        ...(input.billingAddress !== undefined && { billingAddress: normalizeAddress(input.billingAddress) }),
        ...(input.shippingAddress !== undefined && { shippingAddress: normalizeAddress(input.shippingAddress) }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.active !== undefined && { active: input.active }),
      },
      })
      if (result.count > 0) {
        await logActivityInTransaction(tx, { entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', description: `Updated customer: ${input.firstName ?? ''}${input.lastName ? ' ' + input.lastName : ''}`.trim(), userId: session.user.id ?? null })
      }
      return result
    })
    if (written.count === 0) {
      const exists = await db.customer.findUnique({ where: { id }, select: { gdprAnonymisedAt: true } })
      return { success: false, error: exists?.gdprAnonymisedAt ? ANONYMISED_CUSTOMER_REFUSAL : 'Customer not found' }
    }
    revalidatePath('/sales/contacts')
    revalidatePath('/sales')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'CUSTOMER', entityId: id, tag: 'sales', action: 'updated', level: 'ERROR', description: `Failed to update customer: ${String(e)}` })
    return { success: false, error: String(e) }
  }
}

export async function importContactsCsv(formData: FormData): Promise<CsvImportActionResult> {
  const mode = getCsvImportMode(formData)
  const preview = isCsvImportDryRunMode(mode)
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
        gdprAnonymisedAt: true,
      },
    })
    const byId = new Map(customers.map((customer) => [customer.id, customer]))
    const byEmail = new Map<string, typeof customers>()
    const byIdentity = new Map<string, typeof customers>()
    for (const customer of customers) {
      // An anonymised contact carries placeholders, never matches a row by email or name, and is never updated.
      if (customer.gdprAnonymisedAt) continue
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
        if (existing && existing.gdprAnonymisedAt) {
          errors.push(`Row ${lineNum}: ${ANONYMISED_CUSTOMER_REFUSAL}`)
          skipped++
          continue
        }
        if (existing) {
          const billingAddress = mergeImportedAddress(r, 'billing', existing.billingAddress as AddressData | null)
          const shippingAddress = mergeImportedAddress(r, 'shipping', existing.shippingAddress as AddressData | null)
          if (!preview) {
            const written = await db.customer.updateMany({
              where: { id: existing.id, gdprAnonymisedAt: null },
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
            if (written.count === 0) {
              errors.push(`Row ${lineNum}: ${ANONYMISED_CUSTOMER_REFUSAL}`)
              skipped++
              continue
            }
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
    const error = String(e)
    await runCsvImportMutation(mode, () => logActivity({ entityType: 'IMPORT', tag: 'import', action: 'imported', level: 'ERROR', description: `Failed to import contacts from CSV: ${error}` }))
    return preview
      ? createCsvImportPreviewResult({ totalRows: 0, created: 0, updated: 0, errorCount: 1, errors: [error], error })
      : createCsvImportExecutionResult({ created: 0, updated: 0, skipped: 0, errors: [error], error, success: false })
  }
}

export async function anonymiseCustomer(customerId: string): Promise<{ success: boolean; error?: string; warning?: string; openWarehouseOrders?: number; ambiguousWarehouseOrders?: number }> {
  const session = await requirePermission('sync')
  // The erasure itself, and its name-free proof, live in one place: see lib/domain/erasure.
  const result = await eraseCustomerPersonalData(customerId, { trigger: 'ON_REQUEST', userId: session.user.id ?? null })
  if (result.success) revalidatePath('/sales/contacts')
  if (!result.success) return { success: false, error: result.error }
  // The operator is told AT THE TIME OF ERASURE what the erasure did not reach: warehouse orders still open hold the person's name and address, and IMS
  // does not write to the live warehouse. The sentence carries a number only.
  const open = result.warehouse.open
  const ambiguous = result.warehouse.ambiguous
  return open + ambiguous > 0
    ? { success: true, openWarehouseOrders: open, ambiguousWarehouseOrders: ambiguous, warning: openWarehouseOrdersWarning(open, ambiguous) }
    : { success: true }
}
