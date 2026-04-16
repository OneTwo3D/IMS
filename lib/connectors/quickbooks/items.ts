/**
 * QuickBooks Online item (product) management.
 *
 * CRITICAL: Items are created as Type: 'NonInventory' — NOT 'Inventory'.
 * IMS is the single source of truth for stock levels and COGS. If we used
 * QBO's Inventory type, it would auto-track quantities and double-book COGS.
 * Same principle as Xero's untracked items (see lib/connectors/xero/items.ts).
 */

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
 * Find or create a product item in QuickBooks.
 * Always uses Type: 'NonInventory' to avoid stock/COGS double-booking.
 */
export async function findOrCreateItem(
  code: string,
  name: string,
): Promise<{ success: boolean; itemId?: string; error?: string }> {
  try {
    // Search by Name (QBO items are unique by Name)
    const searchRes = await qboQuery<QboQueryResponse>(
      'Item',
      `Name = '${escapeQboQueryValue(code)}'`,
    )
    const existing = searchRes.data?.QueryResponse?.Item?.[0]
    if (existing) return { success: true, itemId: existing.Id }

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
        if (retryItem) return { success: true, itemId: retryItem.Id }
      }
      return { success: false, error: createRes.error ?? 'Failed to create item' }
    }

    return { success: true, itemId: createRes.data.Item.Id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
