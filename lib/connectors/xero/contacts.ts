/**
 * Xero Contact management — find or create contacts (customers & suppliers).
 */

import { db } from '@/lib/db'
import { activeAccountingIdProvenance, accountingIdProvenanceMatches } from '@/lib/connectors/accounting-id-provenance'
import { xeroGet, xeroPost } from './api'

const XERO_CONNECTOR = 'xero'

type XeroContactResponse = {
  Contacts: Array<{
    ContactID: string
    Name: string
    EmailAddress?: string
    IsSupplier: boolean
    IsCustomer: boolean
  }>
}

type ContactRef =
  | { customerId?: string; supplierId?: never }
  | { customerId?: never; supplierId?: string }
  | undefined

function normalizeContactName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function escapeXeroWhereValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildWhereQuery(expression: string): string {
  return `Contacts?where=${encodeURIComponent(expression)}`
}

async function getStoredContactId(ref?: ContactRef): Promise<string | null> {
  const row = ref?.customerId
    ? await db.customer.findUnique({ where: { id: ref.customerId }, select: { accountingContactId: true, accountingContactProvenance: true } })
    : ref?.supplierId
      ? await db.supplier.findUnique({ where: { id: ref.supplierId }, select: { accountingContactId: true, accountingContactProvenance: true } })
      : null
  if (!row?.accountingContactId) return null
  // Ignore an id issued by a different connector/org (o3d-6nd) — resolve it fresh instead.
  const active = await activeAccountingIdProvenance(XERO_CONNECTOR)
  if (!accountingIdProvenanceMatches(row.accountingContactProvenance, active)) return null
  return row.accountingContactId
}

async function storeContactId(contactId: string, ref?: ContactRef): Promise<void> {
  if (!contactId) return
  // RACE (o3d-gfh): provenance sampled after the id-issuing API call — see xero/items.ts.
  const provenance = await activeAccountingIdProvenance(XERO_CONNECTOR)
  if (ref?.customerId) {
    await db.customer.update({
      where: { id: ref.customerId },
      data: { accountingContactId: contactId, accountingContactProvenance: provenance },
    }).catch(() => {})
  } else if (ref?.supplierId) {
    await db.supplier.update({
      where: { id: ref.supplierId },
      data: { accountingContactId: contactId, accountingContactProvenance: provenance },
    }).catch(() => {})
  }
}

/**
 * Find a Xero contact by name, or create one if not found.
 */
export async function findOrCreateContact(
  name: string,
  email?: string,
  isSupplier = false,
  ref?: ContactRef,
): Promise<{ success: boolean; contactId?: string; error?: string }> {
  if (!name) return { success: false, error: 'Contact name is required' }

  const storedContactId = await getStoredContactId(ref)
  if (storedContactId) {
    return { success: true, contactId: storedContactId }
  }

  const normalizedEmail = email?.trim().toLowerCase()
  if (normalizedEmail) {
    const emailRes = await xeroGet<XeroContactResponse>(
      buildWhereQuery(`EmailAddress!=null&&EmailAddress=="${escapeXeroWhereValue(normalizedEmail)}"`),
    )
    if (emailRes.ok && emailRes.data?.Contacts?.length) {
      const contactId = emailRes.data.Contacts[0].ContactID
      await storeContactId(contactId, ref)
      return { success: true, contactId }
    }
  }

  const searchName = normalizeContactName(name)
  const res = await xeroGet<XeroContactResponse>(
    buildWhereQuery(`Name=="${escapeXeroWhereValue(searchName)}"`),
  )

  if (res.ok && res.data?.Contacts?.length) {
    const contactId = res.data.Contacts[0].ContactID
    await storeContactId(contactId, ref)
    return { success: true, contactId }
  }

  // Not found — create
  const contact: Record<string, unknown> = {
    Name: searchName,
    IsSupplier: isSupplier,
    IsCustomer: !isSupplier,
  }
  if (normalizedEmail) contact.EmailAddress = normalizedEmail

  const createRes = await xeroPost<XeroContactResponse>('Contacts', contact)
  if ((!createRes.ok || !createRes.data?.Contacts?.length) && /already exists|has already been used|name already exists/i.test(createRes.error ?? '')) {
    const retryRes = normalizedEmail
      ? await xeroGet<XeroContactResponse>(
          buildWhereQuery(`EmailAddress!=null&&EmailAddress=="${escapeXeroWhereValue(normalizedEmail)}"`),
        )
      : await xeroGet<XeroContactResponse>(
          buildWhereQuery(`Name=="${escapeXeroWhereValue(searchName)}"`),
        )

    if (retryRes.ok && retryRes.data?.Contacts?.length) {
      const contactId = retryRes.data.Contacts[0].ContactID
      await storeContactId(contactId, ref)
      return { success: true, contactId }
    }
  }
  if (!createRes.ok || !createRes.data?.Contacts?.length) {
    return { success: false, error: createRes.error ?? 'Failed to create contact' }
  }

  const contactId = createRes.data.Contacts[0].ContactID
  await storeContactId(contactId, ref)
  return { success: true, contactId }
}
