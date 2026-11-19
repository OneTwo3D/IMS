import { PRODUCER_STEP_ENV } from '@/lib/security/producer-disposition-constants'
import { parseProducerCutoff } from '@/lib/security/producer-disposition'
import type { WooNativeEmailState } from '@/lib/connectors/woocommerce/native-email-state'

/**
 * THE INTERLOCK ON TURNING `storefront_customer_email_enabled` ON (the Settings > Sales screen and `settings:set`).
 *
 * Until step W, WooCommerce sends every customer e-mail for a storefront order. Turning the IMS switch on before then, or while WooCommerce's native e-mails
 * are still on, makes every customer get two e-mails (which cannot be unsent), and `writers:check` stayed green because it asks for nothing before step W. So
 * the switch is REFUSED unless BOTH hold:
 *   1. step W is live: WC_WRITES_LIVE_FROM is set, readable and not in the future, and
 *   2. NATIVE_EMAIL_EXCLUSIVE reads WooCommerce's native e-mails as OFF: a read-only GET of each of the two e-mails IMS replaces answered `no`. A store that does
 *      not answer, or answers anything else, is a refusal (fail closed), not consent.
 * Turning the switch OFF is never refused. Not-ready is the normal state before step W: the refusal says what to do, it never throws.
 */

export type InterlockDeps = {
  env?: Record<string, string | undefined>
  now?: Date
  /** The store's native e-mail read. Absent = the connector's read-only GET (a test seam; tests never reach the network). */
  readNativeEmail?: () => Promise<WooNativeEmailState>
}

const WHAT_TO_DO = 'Switch WooCommerce\'s native processing and completed customer e-mails OFF at step W first, then turn this on.'

/** The refusal text for turning the switch on now, or null when it may be turned on. */
export async function storefrontEmailSwitchOnRefusal(deps: InterlockDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env
  const now = deps.now ?? new Date()
  const name = PRODUCER_STEP_ENV.woocommerce
  const live = parseProducerCutoff(Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined)
  if (!live.ok) {
    return `Cannot turn on customer e-mail for storefront orders: ${name} (step W) is ${live.reason === 'absent' ? 'not set' : 'not readable'}. WooCommerce still sends these e-mails until step W, so IMS would send every customer a second one. `
      + `Set ${name} at step W first. ${WHAT_TO_DO}`
  }
  if (live.ms > now.getTime()) {
    return `Cannot turn on customer e-mail for storefront orders: step W is not live yet (${name} is in the future). ${WHAT_TO_DO}`
  }
  let native: WooNativeEmailState
  try {
    const read = deps.readNativeEmail ?? (async () => (await import('@/lib/connectors/woocommerce/native-email-state')).readWooNativeCustomerEmailState())
    native = await read()
  } catch {
    return 'Cannot turn on customer e-mail for storefront orders: WooCommerce\'s native e-mail settings could not be read, so it is not known that they are off. Nothing was changed.'
  }
  if (!native.ok) {
    return 'Cannot turn on customer e-mail for storefront orders: WooCommerce\'s native e-mail settings could not be read (or were not yes/no), so it is not known that they are off. Nothing was changed.'
  }
  const stillOn = Object.entries(native.enabled).filter(([, on]) => on).map(([id]) => id)
  if (stillOn.length > 0) {
    return `Cannot turn on customer e-mail for storefront orders: WooCommerce still sends ${stillOn.join(' and ')}, so the customer would get two e-mails. ${WHAT_TO_DO}`
  }
  return null
}
