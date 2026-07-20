/**
 * QuickBooks Online customer/vendor (contact) management.
 *
 * Key difference from Xero: QBO has separate Customer and Vendor entities
 * rather than a unified Contact. This module routes to the correct entity
 * based on the isSupplier flag.
 */

import { db } from '@/lib/db'
import { activeAccountingIdProvenance, accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'
import { qboQuery, qboPost, escapeQboQueryValue, type QboResponse } from './api'

const QBO_CONNECTOR = 'quickbooks'

type QboCustomer = {
  Id: string
  DisplayName: string
  PrimaryEmailAddr?: { Address: string }
}

type QboVendor = {
  Id: string
  DisplayName: string
  PrimaryEmailAddr?: { Address: string }
}

type QboQueryResponse<T> = {
  QueryResponse: Record<string, T[] | undefined>
}

type ContactRef = {
  customerId?: string
  supplierId?: string
}

async function getStoredContactId(ref?: ContactRef): Promise<string | null> {
  const row = ref?.customerId
    ? await db.customer.findUnique({ where: { id: ref.customerId }, select: { accountingContactId: true, accountingContactProvenance: true } })
    : ref?.supplierId
      ? await db.supplier.findUnique({ where: { id: ref.supplierId }, select: { accountingContactId: true, accountingContactProvenance: true } })
      : null
  if (!row?.accountingContactId) return null
  // Ignore an id issued by a different connector/org (o3d-6nd) — resolve it fresh instead.
  const active = await activeAccountingIdProvenance(QBO_CONNECTOR)
  if (!accountingIdProvenanceMatches(row.accountingContactProvenance, active)) return null
  return row.accountingContactId
}

async function storeContactId(contactId: string, ref?: ContactRef): Promise<void> {
  // RACE (o3d-gfh): provenance sampled after the id-issuing API call — see xero/items.ts.
  const provenance = await activeAccountingIdProvenance(QBO_CONNECTOR)
  if (ref?.customerId) {
    await db.customer.update({
      where: { id: ref.customerId },
      data: { accountingContactId: contactId, accountingContactProvenance: provenance },
    })
  } else if (ref?.supplierId) {
    await db.supplier.update({
      where: { id: ref.supplierId },
      data: { accountingContactId: contactId, accountingContactProvenance: provenance },
    })
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

async function findCustomerByEmail(email: string): Promise<string | null> {
  const res = await qboQuery<QboQueryResponse<QboCustomer>>(
    'Customer',
    `PrimaryEmailAddr = '${escapeQboQueryValue(email)}'`,
  )
  const customers = res.data?.QueryResponse?.Customer ?? []
  return customers[0]?.Id ?? null
}

async function findCustomerByName(name: string): Promise<string | null> {
  const res = await qboQuery<QboQueryResponse<QboCustomer>>(
    'Customer',
    `DisplayName = '${escapeQboQueryValue(name)}'`,
  )
  const customers = res.data?.QueryResponse?.Customer ?? []
  return customers[0]?.Id ?? null
}

async function createCustomer(name: string, email?: string): Promise<QboResponse<{ Customer: QboCustomer }>> {
  const body: Record<string, unknown> = { DisplayName: name }
  if (email) body.PrimaryEmailAddr = { Address: email }
  return qboPost<{ Customer: QboCustomer }>('customer', body)
}

async function findVendorByEmail(email: string): Promise<string | null> {
  const res = await qboQuery<QboQueryResponse<QboVendor>>(
    'Vendor',
    `PrimaryEmailAddr = '${escapeQboQueryValue(email)}'`,
  )
  const vendors = res.data?.QueryResponse?.Vendor ?? []
  return vendors[0]?.Id ?? null
}

async function findVendorByName(name: string): Promise<string | null> {
  const res = await qboQuery<QboQueryResponse<QboVendor>>(
    'Vendor',
    `DisplayName = '${escapeQboQueryValue(name)}'`,
  )
  const vendors = res.data?.QueryResponse?.Vendor ?? []
  return vendors[0]?.Id ?? null
}

async function createVendor(name: string, email?: string): Promise<QboResponse<{ Vendor: QboVendor }>> {
  const body: Record<string, unknown> = { DisplayName: name }
  if (email) body.PrimaryEmailAddr = { Address: email }
  return qboPost<{ Vendor: QboVendor }>('vendor', body)
}

/**
 * Find or create a customer/vendor in QuickBooks.
 * Routes to Customer or Vendor entity based on isSupplier flag.
 */
export async function findOrCreateContact(
  name: string,
  email?: string,
  isSupplier?: boolean,
  ref?: ContactRef,
): Promise<{ success: boolean; contactId?: string; error?: string }> {
  try {
    // Check cached ID first
    const cached = await getStoredContactId(ref)
    if (cached) return { success: true, contactId: cached }

    const normalizedName = normalizeName(name)

    if (isSupplier) {
      // Search vendor by email, then name
      let vendorId = email ? await findVendorByEmail(email) : null
      if (!vendorId) vendorId = await findVendorByName(normalizedName)

      if (!vendorId) {
        const createRes = await createVendor(normalizedName, email)
        if (!createRes.ok || !createRes.data) {
          // Handle "already exists" race condition — retry search
          if (createRes.error?.includes('already exists') || createRes.error?.includes('Duplicate')) {
            vendorId = await findVendorByName(normalizedName)
          }
          if (!vendorId) {
            return { success: false, error: createRes.error ?? 'Failed to create vendor' }
          }
        } else {
          vendorId = createRes.data.Vendor.Id
        }
      }

      await storeContactId(vendorId, ref)
      return { success: true, contactId: vendorId }
    }

    // Customer path
    let customerId = email ? await findCustomerByEmail(email) : null
    if (!customerId) customerId = await findCustomerByName(normalizedName)

    if (!customerId) {
      const createRes = await createCustomer(normalizedName, email)
      if (!createRes.ok || !createRes.data) {
        // Handle "already exists" race condition — retry search
        if (createRes.error?.includes('already exists') || createRes.error?.includes('Duplicate')) {
          customerId = await findCustomerByName(normalizedName)
        }
        if (!customerId) {
          return { success: false, error: createRes.error ?? 'Failed to create customer' }
        }
      } else {
        customerId = createRes.data.Customer.Id
      }
    }

    await storeContactId(customerId, ref)
    return { success: true, contactId: customerId }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
