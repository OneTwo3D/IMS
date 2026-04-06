/**
 * WooCommerce webhook signature verification.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'

export async function verifyWcWebhook(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false

  const secretSetting = await db.setting.findUnique({ where: { key: 'wc_webhook_secret' } })
  if (!secretSetting?.value) return false

  const expected = createHmac('sha256', secretSetting.value).update(body).digest('base64')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return false
  return timingSafeEqual(sigBuf, expBuf)
}
