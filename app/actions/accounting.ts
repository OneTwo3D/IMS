'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'

// ---------------------------------------------------------------------------
// Connector-agnostic accounting actions.
//
// These actions live in the core system and are independent of which
// accounting integration is active (Xero today, QuickBooks in future). The
// active connector is responsible for interpreting the stored account codes
// in its own chart of accounts.
// ---------------------------------------------------------------------------

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
    await requirePermission('settings.company')

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
 *
 * GATED ON `sync`, NOT `settings.company` (o3d-osl8 round 4). This read has exactly one caller —
 * app/(dashboard)/sync/page.tsx — and that page IS `sync`: it enforces `sync` at its boundary and
 * treats a denial from any of its reads as fatal, because a read demanding MORE than the page does
 * means the two disagree. Gated on `settings.company` it did exactly that, and the disagreement
 * was not theoretical: MANAGER holds `sync` and not `settings.company`, so MANAGER passed the page
 * gate and then died here — including in the every-plugin-disabled + rows-stranded state that the
 * stranded-row list exists to serve, where this page is the ONLY view of those rows.
 *
 * Why re-gating rather than skipping the read for a role without `settings.company`: passing []
 * would hand MANAGER a payment-account map with no combos, which is indistinguishable from "no
 * order has ever carried a payment method" — the failure-rendered-as-emptiness lie this page is
 * built to refuse. And `sync` is not a widening of what the data exposes: the combos are distinct
 * (paymentMethod, currency) pairs off SalesOrder, and every role holding `sync` (ADMIN, MANAGER)
 * already holds `sales`, i.e. can read those orders directly.
 *
 * The WRITE side is untouched: savePaymentAccountMap still requires `settings.company`.
 */
export async function getPaymentMethodCombos(): Promise<
  Array<{ paymentMethod: string; currency: string }>
> {
  await requirePermission('sync')
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
