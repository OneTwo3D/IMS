/**
 * Mirror a WooCommerce anonymisation into IMS: the order WooCommerce anonymised is erased here too (the linked customer only when no live
 * order remains). Order-keyed, so a guest order is reached. Runs inside the importer's update path, BEFORE the update writes anything, so the
 * update that follows reads the erasure marker and withholds the placeholder values instead of writing them.
 *
 * A failure THROWS: the delivery fails (webhook 5xx, so WooCommerce retries; a sweep or retry row stays pending) rather than acknowledging an
 * erasure that did not happen. The message is fixed text; the underlying error can echo the values being written.
 */

import { db } from '@/lib/db'
import { eraseOrderPersonalData } from '@/lib/domain/erasure/erase-personal-data'
import { withWcFirstImportLock } from './first-import-lock'

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

/**
 * For a path that does NOT import (the initial-import pending acknowledgement): mirror a marked delivery onto an order IMS holds, deciding "held?"
 * under the first-import lock so an in-flight first import of the same order has committed (or not started) when the link is read. Throws on a
 * failure or a lock that cannot be had in time, so the delivery is retried. Returns whether an order was held.
 */
export async function mirrorWcAnonymisationIfHeld(wcOrder: { id: number | string }): Promise<{ held: boolean }> {
  return withWcFirstImportLock(wcOrder.id, async () => {
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(wcOrder.id) }, select: { orderId: true } })
    if (!link) return { held: false }
    await mirrorWcAnonymisation(link.orderId)
    return { held: true }
  })
}
