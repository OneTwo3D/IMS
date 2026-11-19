/**
 * WHETHER WOOCOMMERCE STILL SENDS ITS NATIVE CUSTOMER E-MAILS (read-only: two GETs of the store's own e-mail settings).
 *
 * At step W the customer e-mail moves from WooCommerce to IMS and the two must be mutually exclusive, PER E-MAIL: both on is a duplicate e-mail to the customer
 * (which cannot be unsent), both off is nobody sending. This reads the two native e-mails IMS's storefront e-mails replace (each is judged on its own):
 *
 *   customer_processing_order   the order confirmation ("we have received your order")
 *   customer_completed_order    the completed / despatch e-mail
 *
 * through `GET /wp-json/wc/v3/settings/email_<id>` (field `enabled`, `yes` or `no`). Anything else (the store did not answer, the answer is not a
 * settings list, `enabled` is missing or neither `yes` nor `no`) is UNREADABLE and the caller fails closed. The e-mails of other plugins (the partial
 * shipment plugin, AST, TrackShip) are not WooCommerce settings and are not seen: the owner switches them off at the step, and this says so.
 */

import { wcFetch } from './api'

export const WOO_NATIVE_CUSTOMER_EMAIL_IDS = ['customer_processing_order', 'customer_completed_order'] as const
export type WooNativeCustomerEmailId = (typeof WOO_NATIVE_CUSTOMER_EMAIL_IDS)[number]

export type WooNativeEmailState =
  | { ok: true; enabled: Readonly<Record<WooNativeCustomerEmailId, boolean>> }
  | { ok: false }

type Fetcher = (path: string, params?: Record<string, string>) => Promise<{ data: unknown; error?: string }>

/** The native e-mails that are on, by id (empty when every one is off). */
export function nativeEmailsOn(state: Extract<WooNativeEmailState, { ok: true }>): WooNativeCustomerEmailId[] {
  return WOO_NATIVE_CUSTOMER_EMAIL_IDS.filter((id) => state.enabled[id])
}

export function parseWooEmailEnabled(data: unknown): boolean | null {
  if (!Array.isArray(data)) return null
  const field = data.find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === 'enabled')
  const value = field?.value
  if (value === 'yes') return true
  if (value === 'no') return false
  return null
}

/** `fetcher` is for tests; production reads through the connector's own authenticated, read-only transport. */
export async function readWooNativeCustomerEmailState(fetcher: Fetcher = (path, params) => wcFetch(path, params)): Promise<WooNativeEmailState> {
  const enabled = {} as Record<WooNativeCustomerEmailId, boolean>
  for (const id of WOO_NATIVE_CUSTOMER_EMAIL_IDS) {
    let answer: Awaited<ReturnType<Fetcher>>
    try {
      answer = await fetcher(`/settings/email_${id}`)
    } catch {
      return { ok: false }
    }
    if (answer.error !== undefined) return { ok: false }
    const value = parseWooEmailEnabled(answer.data)
    if (value === null) return { ok: false }
    enabled[id] = value
  }
  return { ok: true, enabled }
}
