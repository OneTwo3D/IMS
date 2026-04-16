/**
 * QuickBooks Online customer/vendor (contact) management.
 *
 * Key difference from Xero: QBO has separate Customer and Vendor entities
 * rather than a unified Contact. This module routes to the correct entity
 * based on the isSupplier flag.
 */

import { db } from '@/lib/db'
import { qboQuery, qboPost, escapeQboQueryValue, type QboResponse } from './api'

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
  if (ref?.customerId) {
    const customer = await db.customer.findUnique({
      where: { id: ref.customerId },
      select: { accountingContactId: true },
    })
    return customer?.accountingContactId ?? null
  }
  if (ref?.supplierId) {
    const supplier = await db.supplier.findUnique({
      where: { id: ref.supplierId },
      select: { accountingContactId: true },
    })
    return supplier?.accountingContactId ?? null
  }
  return null
}

async function storeContactId(contactId: string, ref?: ContactRef): Promise<void> {
  if (ref?.customerId) {
    await db.customer.update({
      where: { id: ref.customerId },
      data: { accountingContactId: contactId },
    })
  } else if (ref?.supplierId) {
    await db.supplier.update({
      where: { id: ref.supplierId },
      data: { accountingContactId: contactId },
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
