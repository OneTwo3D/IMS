/**
 * QuickBooks Online item (product) management.
 *
 * CRITICAL: Items are created as Type: 'NonInventory' — NOT 'Inventory'.
 * IMS is the single source of truth for stock levels and COGS. If we used
 * QBO's Inventory type, it would auto-track quantities and double-book COGS.
 * Same principle as Xero's untracked items (see lib/connectors/xero/items.ts).
 */

import { db } from '@/lib/db'
import { qboQuery, qboPost, escapeQboQueryValue, resolveAccountRef } from './api'
import { getQuickBooksSettings } from './settings'

type QboItem = {
  Id: string
  Name: string
  Type: string
  Active: boolean
}

type QboQueryResponse = {
  QueryResponse: {
    Item?: QboItem[]
  }
}

/**
 * The QBO item Id already resolved for this code, if any.
 *
 * Product.accountingItemId is connector-agnostic (like accountingContactId): it holds an id owned
 * by whichever accounting connector is connected, and both connectors clear it on disconnect, so a
 * Xero ItemID can never be read back here as a QBO Id (o3d-3nc).
 */
async function getStoredItemId(code: string): Promise<string | null> {
  const row = await db.product.findUnique({
    where: { sku: code },
    select: { accountingItemId: true },
  })
  return row?.accountingItemId ?? null
}

/**
 * Remember the item id for this code.
 *
 * updateMany, not update: 'Shipping' (invoices.ts) is a real caller and is not a catalogue product,
 * so a no-match must be a silent no-op. The catch covers the unique-index race — losing the entry
 * only costs one lookup next time.
 */
async function storeItemId(code: string, itemId: string): Promise<void> {
  if (!itemId) return
  await db.product.updateMany({
    where: { sku: code },
    data: { accountingItemId: itemId },
  }).catch(() => {})
}

/**
 * Find or create a product item in QuickBooks.
 * Always uses Type: 'NonInventory' to avoid stock/COGS double-booking.
 */
export async function findOrCreateItem(
  code: string,
  name: string,
): Promise<{ success: boolean; itemId?: string; error?: string }> {
  try {
    // Resolved once already — skip the round trip (o3d-3nc).
    const storedItemId = await getStoredItemId(code)
    if (storedItemId) return { success: true, itemId: storedItemId }

    // Search by Name (QBO items are unique by Name)
    const searchRes = await qboQuery<QboQueryResponse>(
      'Item',
      `Name = '${escapeQboQueryValue(code)}'`,
    )
    const existing = searchRes.data?.QueryResponse?.Item?.[0]
    if (existing) {
      await storeItemId(code, existing.Id)
      return { success: true, itemId: existing.Id }
    }

    // Resolve account refs for the item
    const settings = await getQuickBooksSettings()
    const incomeRef = await resolveAccountRef(settings.quickbooks_sales_account)
    const expenseRef = await resolveAccountRef(settings.quickbooks_cogs_account)

    if (!incomeRef) {
      return { success: false, error: 'Cannot create item: sales account not configured or not found in QuickBooks' }
    }
    if (!expenseRef) {
      return { success: false, error: 'Cannot create item: COGS account not configured or not found in QuickBooks' }
    }

    const body: Record<string, unknown> = {
      Name: code.substring(0, 100), // QBO name limit
      Description: name.substring(0, 4000),
      Type: 'NonInventory',
      IncomeAccountRef: incomeRef,
      ExpenseAccountRef: expenseRef,
    }

    const createRes = await qboPost<{ Item: QboItem }>('item', body)
    if (!createRes.ok || !createRes.data) {
      // Handle name collision race condition
      if (createRes.error?.includes('already exists') || createRes.error?.includes('Duplicate')) {
        const retryRes = await qboQuery<QboQueryResponse>(
          'Item',
          `Name = '${escapeQboQueryValue(code)}'`,
        )
        const retryItem = retryRes.data?.QueryResponse?.Item?.[0]
        if (retryItem) {
          await storeItemId(code, retryItem.Id)
          return { success: true, itemId: retryItem.Id }
        }
      }
      return { success: false, error: createRes.error ?? 'Failed to create item' }
    }

    await storeItemId(code, createRes.data.Item.Id)
    return { success: true, itemId: createRes.data.Item.Id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
