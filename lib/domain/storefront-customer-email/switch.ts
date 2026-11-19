import { db } from '@/lib/db'
import { STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY, STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY, parseStorefrontEmailEnabledAt } from './constants'

/** The switch for customer e-mail on storefront orders. Absent or anything but 'true' is OFF. Its own module so the e-mail builders can read it without importing the outbox. */
export async function isStorefrontCustomerEmailEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY }, select: { value: true } })
  return row?.value === 'true'
}

/** The instant the switch was turned on (`storefront_customer_email_enabled_at`), or null when absent or unreadable. */
export async function readStorefrontCustomerEmailEnabledAt(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY }, select: { value: true } })
  return parseStorefrontEmailEnabledAt(row?.value)
}
