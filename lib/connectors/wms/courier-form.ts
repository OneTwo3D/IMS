import type { WmsOrderPushInput } from './types'

/**
 * The input for the legacy "{method_id}:{method_title}" form of an order whose courier service is the language-independent
 * key: the legacy name becomes the name sent, and the courier map is consulted against it and the remaining alternates
 * (bare title, method id), never the key. Shared by the create's one retry and by amendments of an order the create moved to
 * that form, so both resolve the same override (and so send the same CourierServiceId). Null when the input carries no key.
 */
export function legacyCourierFormInput(input: WmsOrderPushInput): WmsOrderPushInput | null {
  const legacy = input.courierServiceLegacy
  if (!legacy || !input.courierService || legacy === input.courierService) return null
  return {
    ...input,
    courierService: legacy,
    courierServiceAlternates: (input.courierServiceAlternates ?? []).filter((n) => n !== input.courierService && n !== legacy),
    courierServiceLegacy: null,
  }
}
