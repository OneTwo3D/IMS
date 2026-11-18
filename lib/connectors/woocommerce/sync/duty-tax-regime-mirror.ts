/**
 * Store the order's IOSS number and delivery term from its EU VAT stamp and the shop IOSS number setting (see shop-ioss-number.ts).
 * Runs after an import or update. It never decides a regime: an order with no stamp (the Sales Invoices switch off, or not decided yet) is left as it is.
 * It never throws into the import: a failure is logged and the next delivery retries.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { iossFieldsFromRegime, parseShopIossNumber, SHOP_IOSS_NUMBER_SETTING } from '@/lib/domain/accounting/shop-ioss-number'

export const SHOP_IOSS_NUMBER_MISSING_ACTION = 'shop_ioss_number_missing'

export async function mirrorIossFromRegime(orderId: string): Promise<void> {
  try {
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: { euVatRegime: true, euVatRegimeStampedAt: true, iossNumber: true, deliveryTerm: true },
    })
    if (!order || !order.euVatRegimeStampedAt) return
    const row = await db.setting.findUnique({ where: { key: SHOP_IOSS_NUMBER_SETTING } })
    const shopNumber = parseShopIossNumber(row?.value)
    const next = iossFieldsFromRegime(order.euVatRegime, shopNumber)
    if (next.iossNumber !== order.iossNumber || next.deliveryTerm !== order.deliveryTerm) {
      await db.salesOrder.update({ where: { id: orderId }, data: { iossNumber: next.iossNumber, deliveryTerm: next.deliveryTerm } })
    }
    if (order.euVatRegime === 'IOSS' && shopNumber === null) {
      const already = await db.activityLog.findFirst({ where: { entityType: 'SALES_ORDER', entityId: orderId, action: SHOP_IOSS_NUMBER_MISSING_ACTION }, select: { id: true } })
      if (!already) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: orderId,
          action: SHOP_IOSS_NUMBER_MISSING_ACTION,
          tag: 'sync',
          level: 'WARNING',
          description: 'This order is under the IOSS scheme but the shop IOSS number is not set (or is not in the form IM plus ten digits), so no IOSS number is stored and none will be sent to the warehouse. Set the shop IOSS number in the integration settings.',
          resolveUser: false,
        })
      }
    }
  } catch (error) {
    console.error(`[wc-ioss-mirror] ${orderId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
