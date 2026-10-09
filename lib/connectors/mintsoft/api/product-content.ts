/**
 * MINTSOFT PRODUCT CONTENT: THE WIRE FORMAT AND THE SEND, AND NOTHING ELSE.
 *
 * Product CONTENT (description, short description, picture) is authored in WooCommerce and reaches Mintsoft through
 * IMS. This file knows how Mintsoft is told; WHETHER it is told (the producer disposition, change detection, the
 * never-empty rule) is decided by sync/product-content-sync.ts before anything here runs.
 *
 * It is a `POST /api/Product` carrying the product's ID, its SKU and ONLY the changed content fields, so product
 * meta (name, barcode, weight, customs data) is not in the body and cannot be touched by a content update.
 *
 * CONTRACT STATUS (read this before enabling a live write). Mintsoft was not called to write this. What is known:
 *   - `ImageURL` is a field IMS has sent in the product upsert for a long time (VERIFIED in use).
 *   - `Description` and `ShortDescription` are the names the repository's Mintsoft connector plan lists; their exact
 *     wire names and whether a body of ID + SKU + changed fields leaves the other fields alone are NOT verified.
 * An unverified field is therefore never sent: `verified: false` below keeps it a shadow even when the producer
 * disposition says LIVE. Flip it only after a read-only capture of GET /api/Product/{id} shows the field, and a
 * single granted, controlled update confirms a partial body is not a replace.
 */

import type { WmsProductContentResult, WmsProductContentUpdate } from '@/lib/connectors/wms/types'
import { mintsoftRequest } from './client'

export type MintsoftContentField = 'description' | 'shortDescription' | 'imageUrl'

export const MINTSOFT_CONTENT_WIRE: Readonly<Record<MintsoftContentField, { wire: string; verified: boolean }>> = {
  description: { wire: 'Description', verified: false },
  shortDescription: { wire: 'ShortDescription', verified: false },
  imageUrl: { wire: 'ImageURL', verified: true },
}

export const MINTSOFT_CONTENT_FIELDS = Object.keys(MINTSOFT_CONTENT_WIRE) as MintsoftContentField[]

export function buildMintsoftProductContentRequest(update: WmsProductContentUpdate): {
  path: string
  method: 'POST'
  body: string
} {
  const sku = update.sku.trim()
  const externalProductId = update.externalProductId.trim()
  if (!sku || !externalProductId) throw new Error('A Mintsoft content update needs the product id and SKU')
  const body: Record<string, unknown> = {
    ID: /^\d+$/.test(externalProductId) ? Number.parseInt(externalProductId, 10) : externalProductId,
    SKU: sku,
  }
  let fields = 0
  for (const field of MINTSOFT_CONTENT_FIELDS) {
    const value = update[field]
    if (value === undefined) continue
    // THE NEVER-EMPTY RULE, at the lowest level: a blank value is refused here, so no caller can send an erasure.
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Refusing to send an empty ${field} to Mintsoft: content is never erased by an empty value`)
    }
    body[MINTSOFT_CONTENT_WIRE[field].wire] = value
    fields += 1
  }
  if (fields === 0) throw new Error('A Mintsoft content update needs at least one content field')
  return { path: '/api/Product', method: 'POST', body: JSON.stringify(body) }
}

export async function updateMintsoftProductContent(update: WmsProductContentUpdate): Promise<WmsProductContentResult> {
  const request = buildMintsoftProductContentRequest(update)
  const result = await mintsoftRequest<unknown>(request.path, { method: request.method, body: request.body })
  if (result.held) return { sent: false, held: true, message: result.error ?? 'The outbound-write hold refused the request.' }
  if (result.error) throw new Error(result.error)
  return { sent: true }
}
