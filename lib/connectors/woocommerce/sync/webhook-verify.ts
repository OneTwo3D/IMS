/**
 * WooCommerce webhook signature verification.
 *
 * Secret rotation (o3d-hqvrp.91): WooCommerce signs each webhook with the secret stored ON THE
 * WC WEBHOOK, so after IMS's secret is rotated every existing hook keeps signing with the old one
 * until the operator re-runs "Setup Webhooks". `saveWcSyncSettings` therefore keeps the replaced
 * secret as `wc_webhook_secret_previous` together with an expiry (`wc_webhook_secret_previous_until`,
 * epoch ms) and a delivery signed with it is accepted until that moment. Both values are checked with
 * the same constant-time HMAC compare as the current secret; after the expiry only the current
 * secret works, so nothing is weakened for longer than the grace window.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { getSettingValue } from '@/lib/settings-store'

export const WC_WEBHOOK_SECRET_PREVIOUS_KEY = 'wc_webhook_secret_previous'
export const WC_WEBHOOK_SECRET_PREVIOUS_UNTIL_KEY = 'wc_webhook_secret_previous_until'
/** How long a rotated-out secret is still accepted. */
export const WC_WEBHOOK_SECRET_GRACE_HOURS = 48

function signatureMatches(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('base64')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length) return false
  return timingSafeEqual(sigBuf, expBuf)
}

export async function verifyWcWebhook(body: string, signature: string | null, now: number = Date.now()): Promise<boolean> {
  if (!signature) return false

  const secret = await getSettingValue('wc_webhook_secret')
  if (!secret) return false
  if (signatureMatches(body, signature, secret)) return true

  // Rotation grace: only consulted when the current secret did not match.
  const [previous, untilRaw] = await Promise.all([
    getSettingValue(WC_WEBHOOK_SECRET_PREVIOUS_KEY),
    getSettingValue(WC_WEBHOOK_SECRET_PREVIOUS_UNTIL_KEY),
  ])
  const until = Number(untilRaw)
  if (!previous || !Number.isFinite(until) || until <= now) return false
  return signatureMatches(body, signature, previous)
}
