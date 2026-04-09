/**
 * Xero Contact management — find or create contacts (customers & suppliers).
 */

import { xeroGet, xeroPost } from './api'

type XeroContactResponse = {
  Contacts: Array<{
    ContactID: string
    Name: string
    EmailAddress?: string
    IsSupplier: boolean
    IsCustomer: boolean
  }>
}

/**
 * Find a Xero contact by name, or create one if not found.
 */
export async function findOrCreateContact(
  name: string,
  email?: string,
  isSupplier = false,
): Promise<{ success: boolean; contactId?: string; error?: string }> {
  if (!name) return { success: false, error: 'Contact name is required' }

  // Search by exact name
  const searchName = name.replace(/"/g, '')
  const res = await xeroGet<XeroContactResponse>(`Contacts?where=Name=="${encodeURIComponent(searchName)}"`)

  if (res.ok && res.data?.Contacts?.length) {
    return { success: true, contactId: res.data.Contacts[0].ContactID }
  }

  // Not found — create
  const contact: Record<string, unknown> = {
    Name: name,
    IsSupplier: isSupplier,
    IsCustomer: !isSupplier,
  }
  if (email) contact.EmailAddress = email

  const createRes = await xeroPost<XeroContactResponse>('Contacts', contact)
  if (!createRes.ok || !createRes.data?.Contacts?.length) {
    return { success: false, error: createRes.error ?? 'Failed to create contact' }
  }

  return { success: true, contactId: createRes.data.Contacts[0].ContactID }
}
