'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { auth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// Connector-agnostic accounting actions.
//
// These actions live in the core system and are independent of which
// accounting integration is active (Xero today, QuickBooks in future). The
// active connector is responsible for interpreting the stored account codes
// in its own chart of accounts.
// ---------------------------------------------------------------------------

async function requireAdmin() {
  const session = await auth()
  if (!session?.user?.id || !['ADMIN', 'MANAGER'].includes(session.user.role)) {
    throw new Error('Unauthorized')
  }
  return session
}

/**
 * Save the payment method + currency → bank/clearing account map.
 *
 * The map is stored as JSON under the generic setting key
 * `accounting_payment_account_map`. Keys are formatted as `method:currency`
 * (with `method:*` as a currency wildcard). Values are the account codes that
 * the active accounting connector understands.
 */
export async function savePaymentAccountMap(
  mapJson: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await requireAdmin()

    // Validate it's parseable JSON so we never persist garbage
    try {
      const parsed = JSON.parse(mapJson)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected JSON object')
      }
    } catch (e) {
      return { success: false, error: `Invalid payment account map: ${String(e)}` }
    }

    await db.setting.upsert({
      where: { key: 'accounting_payment_account_map' },
      create: { key: 'accounting_payment_account_map', value: mapJson },
      update: { value: mapJson },
    })

    await logActivity({
      entityType: 'SYSTEM',
      action: 'payment_account_map_updated',
      tag: 'sync',
      description: 'Updated payment account mapping',
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Get distinct payment method + currency combos from existing sales orders.
 * Used by the UI to pre-populate the mapping table with combos the business
 * has actually seen. This is connector-agnostic — it queries our own order
 * data, not the accounting integration.
 */
export async function getPaymentMethodCombos(): Promise<
  Array<{ paymentMethod: string; currency: string }>
> {
  const rows = await db.salesOrder.findMany({
    where: { paymentMethod: { not: null } },
    select: { paymentMethod: true, currency: true },
    distinct: ['paymentMethod', 'currency'],
    orderBy: [{ paymentMethod: 'asc' }, { currency: 'asc' }],
  })
  return rows
    .filter((r): r is { paymentMethod: string; currency: string } => !!r.paymentMethod)
    .map((r) => ({ paymentMethod: r.paymentMethod, currency: r.currency }))
}
