/**
 * Mirror a WooCommerce anonymisation into IMS: the order WooCommerce anonymised is erased here too (the linked customer only when no live
 * order remains). Order-keyed, so a guest order is reached. Runs inside the importer's update path, BEFORE the update writes anything, so the
 * update that follows reads the erasure marker and withholds the placeholder values instead of writing them.
 *
 * A failure THROWS: the delivery fails (webhook 5xx, so WooCommerce retries; a sweep or retry row stays pending) rather than acknowledging an
 * erasure that did not happen. The message is fixed text; the underlying error can echo the values being written.
 */

import { eraseOrderPersonalData } from '@/lib/domain/erasure/erase-personal-data'

export class WcAnonymisationMirrorFailed extends Error {
  constructor() {
    super('The WooCommerce anonymisation could not be mirrored into IMS; the delivery will be retried')
    this.name = 'WcAnonymisationMirrorFailed'
  }
}

export async function mirrorWcAnonymisation(orderId: string): Promise<{ erasedNow: boolean }> {
  const result = await eraseOrderPersonalData(orderId, { trigger: 'MIRRORED_FROM_STOREFRONT', userId: null })
  if (!result.success) throw new WcAnonymisationMirrorFailed()
  return { erasedNow: !result.already }
}
