import { wooProducerSeam } from './producer-seam'

/**
 * THE PRODUCER SEAM OF THE WOOCOMMERCE OPERATOR ACTIONS that call out directly (register webhooks, push FX rates now, probe the
 * FX helper plugin). They live here and not in app/actions/wc-sync.ts because a 'use server' file may export only async
 * server actions, and a helper exported from it would become a callable endpoint.
 *
 * Each returns null to go ahead (the hold is not enforced for WooCommerce, or the decision is LIVE) or `{ notice }` when the
 * decision is SHADOW: nothing was sent, a shadow record was kept, and `notice` is the single-sourced sentence to show the
 * operator. They are never a failure: the action reports the notice and does nothing else.
 */
export type WooActionShadow = { notice: string }

export async function wooWebhookRegistrationShadow(): Promise<WooActionShadow | null> {
  const seam = await wooProducerSeam({
    operation: 'webhooks',
    subjectType: 'WebhookRegistration',
    subjectId: 'storefront-webhooks',
    payload: { topics: ['order.created', 'order.updated', 'product.updated'] },
  })
  return seam.proceed ? null : { notice: seam.notice }
}

export async function wooFxRatePushShadow(): Promise<WooActionShadow | null> {
  const seam = await wooProducerSeam({
    operation: 'fx-rates',
    subjectType: 'FxRates',
    subjectId: 'current',
    payload: { kind: 'current-rates' },
  })
  return seam.proceed ? null : { notice: seam.notice }
}

export async function wooFxHelperProbeShadow(): Promise<WooActionShadow | null> {
  const seam = await wooProducerSeam({
    operation: 'fx-rates',
    subjectType: 'FxHelperProbe',
    subjectId: 'probe',
    payload: { kind: 'helper-probe' },
  })
  return seam.proceed ? null : { notice: seam.notice }
}
