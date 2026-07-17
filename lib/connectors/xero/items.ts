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

import { db } from '@/lib/db'
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
 * The Xero ItemID already resolved for this SKU, if any.
 *
 * Item codes ARE product SKUs, so the product row is the natural home for the mapping — the same
 * shape as Customer/Supplier.accountingContactId and Product.externalProductId (o3d-3nc).
 */
async function getStoredItemId(code: string): Promise<string | null> {
  const row = await db.product.findUnique({
    where: { sku: code },
    select: { accountingItemId: true },
  })
  return row?.accountingItemId ?? null
}

/**
 * Remember the item id for this SKU.
 *
 * updateMany, not update: a code that matches no product must be a silent no-op rather than a throw
 * (callers may pass a pseudo-item code that is not a catalogue product).
 *
 * Never fatal — failing to CACHE an id must not fail an invoice that Xero already accepted — but not
 * silent either. A caching layer that quietly stops caching looks exactly like one that works, right
 * up until the daily call budget is gone; that invisibility is the whole reason this column exists.
 * So swallow the failure and say so.
 */
async function storeItemId(code: string, itemId: string): Promise<void> {
  if (!itemId) return
  try {
    await db.product.updateMany({
      where: { sku: code },
      data: { accountingItemId: itemId },
    })
  } catch (e) {
    console.warn(
      `[xero] could not cache item id ${itemId} for SKU ${code}; the invoice is unaffected but this ` +
      `SKU will cost a lookup on every future invoice until it succeeds: ${String(e)}`,
    )
  }
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

  // Already resolved once — the item exists, so there is nothing to look up or create. This is the
  // whole point of the column: item lookups were ~75% of the calls it takes to post an invoice
  // (one GET per distinct SKU, per invoice, forever) against a 1,000/org/day cap (o3d-3nc).
  const storedItemId = await getStoredItemId(code)
  if (storedItemId) {
    return { success: true, itemId: storedItemId }
  }

  // Search by code
  const where = `Items?where=${encodeURIComponent(`Code=="${escapeXeroWhereValue(code)}"`)}`
  const res = await xeroGet<XeroItemResponse>(where)

  if (res.ok && res.data?.Items?.length) {
    const itemId = res.data.Items[0].ItemID
    await storeItemId(code, itemId)
    return { success: true, itemId }
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
      const itemId = retryRes.data.Items[0].ItemID
      await storeItemId(code, itemId)
      return { success: true, itemId }
    }
  }
  if (!createRes.ok || !createRes.data?.Items?.length) {
    return { success: false, error: createRes.error ?? 'Failed to create item' }
  }

  const itemId = createRes.data.Items[0].ItemID
  await storeItemId(code, itemId)
  return { success: true, itemId }
}
