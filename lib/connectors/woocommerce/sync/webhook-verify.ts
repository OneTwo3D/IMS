/**
 * WooCommerce webhook signature verification.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { getSettingValue } from '@/lib/settings-store'

export async function verifyWcWebhook(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false

  const secret = await getSettingValue('wc_webhook_secret')
  if (!secret) return false

  const expected = createHmac('sha256', secret).update(body).digest('base64')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return false
  return timingSafeEqual(sigBuf, expBuf)
}
