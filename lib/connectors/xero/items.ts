/**
 * Xero Item management — find or create product items.
 *
 * All items are created as UNTRACKED (no inventory tracking in Xero).
 * One Two Inventory is the source of truth for stock, COGS and valuations —
 * Xero only records the sales/purchase side of transactions. To keep Xero
 * items untracked we must NEVER set `InventoryAssetAccountCode`; if that
 * field is present Xero automatically promotes the item to a tracked
 * inventory item, which would double-book cost of goods sold.
 */

import { xeroGet, xeroPost } from './api'

type XeroItemResponse = {
  Items: Array<{
    ItemID: string
    Code: string
    Name: string
  }>
}

function escapeXeroWhereValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Find a Xero item by code (SKU), or create one if not found.
 *
 * The created item is always untracked — we deliberately omit
 * `InventoryAssetAccountCode` so Xero treats the item as a non-inventory
 * (service-style) item. IMS remains the single source of truth for stock.
 */
export async function findOrCreateItem(
  code: string,
  name: string,
  salesAccountCode?: string,
  purchaseAccountCode?: string,
): Promise<{ success: boolean; itemId?: string; error?: string }> {
  if (!code) return { success: false, error: 'Item code is required' }

  // Search by code
  const where = `Items?where=${encodeURIComponent(`Code=="${escapeXeroWhereValue(code)}"`)}`
  const res = await xeroGet<XeroItemResponse>(where)

  if (res.ok && res.data?.Items?.length) {
    return { success: true, itemId: res.data.Items[0].ItemID }
  }

  // Create new UNTRACKED item. Do NOT add InventoryAssetAccountCode — its
  // presence would make Xero treat the item as tracked inventory.
  const item: Record<string, unknown> = {
    Code: code,
    Name: name.substring(0, 50), // Xero limits item name to 50 chars
    IsSold: true,
    IsPurchased: true,
  }
  if (salesAccountCode) item.SalesDetails = { AccountCode: salesAccountCode }
  if (purchaseAccountCode) item.PurchaseDetails = { AccountCode: purchaseAccountCode }

  const createRes = await xeroPost<XeroItemResponse>('Items', item)
  if ((!createRes.ok || !createRes.data?.Items?.length) && /already exists|has already been used|code already exists/i.test(createRes.error ?? '')) {
    const retryRes = await xeroGet<XeroItemResponse>(where)
    if (retryRes.ok && retryRes.data?.Items?.length) {
      return { success: true, itemId: retryRes.data.Items[0].ItemID }
    }
  }
  if (!createRes.ok || !createRes.data?.Items?.length) {
    return { success: false, error: createRes.error ?? 'Failed to create item' }
  }

  return { success: true, itemId: createRes.data.Items[0].ItemID }
}
