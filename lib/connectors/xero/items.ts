/**
 * Xero Item management — find or create product items.
 * Items are created with IsTrackedAsInventory: false (IMS manages inventory).
 */

import { xeroGet, xeroPost } from './api'

type XeroItemResponse = {
  Items: Array<{
    ItemID: string
    Code: string
    Name: string
  }>
}

/**
 * Find a Xero item by code (SKU), or create one if not found.
 */
export async function findOrCreateItem(
  code: string,
  name: string,
  salesAccountCode?: string,
  purchaseAccountCode?: string,
): Promise<{ success: boolean; itemId?: string; error?: string }> {
  if (!code) return { success: false, error: 'Item code is required' }

  // Search by code
  const res = await xeroGet<XeroItemResponse>(`Items?where=Code=="${encodeURIComponent(code)}"`)

  if (res.ok && res.data?.Items?.length) {
    return { success: true, itemId: res.data.Items[0].ItemID }
  }

  // Create new item — not tracked as inventory (IMS manages stock)
  const item: Record<string, unknown> = {
    Code: code,
    Name: name.substring(0, 50), // Xero limits item name to 50 chars
    IsSold: true,
    IsPurchased: true,
  }
  if (salesAccountCode) item.SalesDetails = { AccountCode: salesAccountCode }
  if (purchaseAccountCode) item.PurchaseDetails = { AccountCode: purchaseAccountCode }

  const createRes = await xeroPost<XeroItemResponse>('Items', item)
  if (!createRes.ok || !createRes.data?.Items?.length) {
    return { success: false, error: createRes.error ?? 'Failed to create item' }
  }

  return { success: true, itemId: createRes.data.Items[0].ItemID }
}
