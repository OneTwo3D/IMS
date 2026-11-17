import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { mintsoftProducerSeam } from '../producer-seam'
import { normalizeMintsoftProduct } from '../api/normalizers'
import { readMintsoftParentSkuDeleteEnabled } from '../settings/product-parity'

/**
 * DELETING A VARIABLE PRODUCT'S PARENT SKU FROM MINTSOFT (o3d-zvec.20), PORTED FROM THE PYTHON SYNC'S DEFERRED PARENT DELETE.
 *
 * Only the variations of a variable product are meant to exist in Mintsoft; the parent record is obsolete. But the delete cannot be
 * undone, so this is FAIL-CLOSED: it deletes only on positive proof, and on any doubt it REFUSES and records the refusal for an
 * operator (an audit-event row, action `parent_sku_delete_refused`, naming the SKU and the reasons). It never deletes "probably".
 *
 * It runs only behind `mintsoft_parent_sku_delete_enabled` (default OFF, and it needs `mintsoft_product_parity_enabled` too), only at
 * the end of a full product verify run, and only through the producer seam (so IMS shadows it until it is the live writer).
 *
 * THE PROOF, from a FRESH read of the stored product links (no Mintsoft call): for EVERY non-archived variation of the parent
 *   - it has a Mintsoft link, with no recorded error and a payload hash;
 *   - the link was refreshed by THIS verify run (`updatedAt` is not before the run began), so a variation the run skipped, shadowed
 *     or failed on cannot count as confirmed on yesterday's evidence;
 *   - the link's stored Mintsoft record is a real product echo whose id is the link's id and whose SKU is the variation's SKU;
 *   - no two variations share a Mintsoft id, and none shares the parent's id or SKU (a "replacement" that IS the parent record
 *     would be deleted with it).
 * The same read is repeated immediately before the call and must reach the same verdict.
 */

export type ParentLinkRead = {
  externalProductId: string
  payloadHash: string | null
  lastError: string | null
  metadata: Prisma.JsonValue | null
  updatedAt: Date
}

export type ParentDeletionRead = {
  productId: string
  sku: string
  type: string
  parentLink: ParentLinkRead | null
  variations: Array<{ id: string; sku: string; lifecycleStatus: string; link: ParentLinkRead | null }>
}

export type ParentDeletionVerdict =
  | { kind: 'delete'; parentExternalId: string; replacements: number }
  | { kind: 'refuse'; reasons: string[] }

const sameSku = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function confirmationProblem(variationSku: string, link: ParentLinkRead | null, since: Date): string | null {
  if (!link) return `${variationSku}: no Mintsoft link`
  if (!/^\d+$/.test(link.externalProductId.trim())) return `${variationSku}: its Mintsoft id is not a number`
  if (link.lastError) return `${variationSku}: its link records an error`
  if (!link.payloadHash) return `${variationSku}: its link has no payload hash (never matched or sent)`
  if (link.updatedAt.getTime() < since.getTime()) return `${variationSku}: its link was not refreshed by this run`
  const echoed = normalizeMintsoftProduct(link.metadata)
  if (!echoed) return `${variationSku}: no stored Mintsoft record for it`
  if (echoed.externalId !== link.externalProductId.trim()) return `${variationSku}: the stored Mintsoft record has a different id`
  if (!sameSku(echoed.sku, variationSku)) return `${variationSku}: the stored Mintsoft record carries a different SKU`
  return null
}

/** Pure: given a fresh read, may the parent be deleted? Every doubt is a refusal, and all of them are listed. */
export function decideParentSkuDeletion(read: ParentDeletionRead, since: Date): ParentDeletionVerdict {
  const reasons: string[] = []
  if (read.type !== 'VARIABLE') reasons.push('the product is not a variable product')
  const parentLink = read.parentLink
  if (!parentLink || !/^\d+$/.test(parentLink.externalProductId.trim())) reasons.push('the parent has no usable Mintsoft link')

  const expected = read.variations.filter((variation) => variation.lifecycleStatus !== 'ARCHIVED')
  if (expected.length === 0) reasons.push('the parent has no live variation to replace it')
  for (const variation of expected) {
    if (!variation.sku.trim()) { reasons.push(`variation ${variation.id}: no SKU`); continue }
    const problem = confirmationProblem(variation.sku, variation.link, since)
    if (problem) reasons.push(problem)
    if (sameSku(variation.sku, read.sku)) reasons.push(`${variation.sku}: a variation has the parent's own SKU`)
  }

  const ids = expected.map((variation) => variation.link?.externalProductId.trim()).filter((id): id is string => Boolean(id))
  if (new Set(ids).size !== ids.length) reasons.push('two variations point at the same Mintsoft record')
  if (parentLink && ids.includes(parentLink.externalProductId.trim())) reasons.push('a variation points at the parent\'s own Mintsoft record')

  if (reasons.length > 0 || !parentLink) return { kind: 'refuse', reasons }
  return { kind: 'delete', parentExternalId: parentLink.externalProductId.trim(), replacements: expected.length }
}

const LINK_SELECT = { externalProductId: true, payloadHash: true, lastError: true, metadata: true, updatedAt: true } as const

async function readParent(productId: string): Promise<ParentDeletionRead | null> {
  const row = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      sku: true,
      type: true,
      wmsProductLinks: { where: { connector: 'mintsoft' }, select: LINK_SELECT, take: 1 },
      variants: {
        select: { id: true, sku: true, lifecycleStatus: true, wmsProductLinks: { where: { connector: 'mintsoft' }, select: LINK_SELECT, take: 1 } },
      },
    },
  })
  if (!row) return null
  return {
    productId: row.id,
    sku: row.sku,
    type: row.type,
    parentLink: row.wmsProductLinks[0] ?? null,
    variations: row.variants.map((variant) => ({ id: variant.id, sku: variant.sku, lifecycleStatus: variant.lifecycleStatus, link: variant.wmsProductLinks[0] ?? null })),
  }
}

async function recordRefusal(read: ParentDeletionRead, reasons: string[], jobTriggeredBy: string) {
  await recordWmsMutationEvent({
    connector: 'mintsoft', direction: 'OUTBOUND', action: 'parent_sku_delete_refused', outcome: 'FAILED',
    entityType: 'PRODUCT', entityId: read.productId, externalId: read.parentLink?.externalProductId ?? null,
    summary: `Mintsoft parent SKU ${read.sku} NOT deleted: ${reasons.length} reason${reasons.length === 1 ? '' : 's'}. An operator decides.`,
    before: { sku: read.sku, parentExternalProductId: read.parentLink?.externalProductId ?? null },
    after: { refused: true, reasons: reasons.slice(0, 20) },
    error: reasons.slice(0, 5).join('; '),
    triggeredBy: jobTriggeredBy,
  })
}

export type ParentDeletionCounters = { considered: number; deleted: number; refused: number; shadowed: number; held: number; errors: number }

type ParentDeletionContext = { connector: ReturnType<typeof getWmsConnector>; since: Date; triggeredBy: string }

/** The ONE place a parent is deleted. The seam asks first; a shadow deletes nothing and leaves the link as it was. */
async function deleteConfirmedParent(
  read: ParentDeletionRead,
  verdict: Extract<ParentDeletionVerdict, { kind: 'delete' }>,
  context: ParentDeletionContext,
): Promise<keyof Omit<ParentDeletionCounters, 'considered'>> {
  if (typeof context.connector.deleteProduct !== 'function') {
    await recordRefusal(read, ['the connector cannot delete a product'], context.triggeredBy)
    return 'refused'
  }
  const seam = await mintsoftProducerSeam({
    operation: 'product.delete',
    subjectType: 'Product',
    subjectId: read.productId,
    payload: { sku: read.sku, externalProductId: verdict.parentExternalId, replacements: verdict.replacements },
    summary: { sku: read.sku, replacements: verdict.replacements },
  })
  if (!seam.proceed) return 'shadowed'

  const outcome = await context.connector.deleteProduct(verdict.parentExternalId, seam.clearance)
  if (!outcome.deleted) {
    await recordWmsMutationEvent({
      connector: 'mintsoft', direction: 'OUTBOUND', action: 'parent_sku_delete', outcome: 'FAILED',
      entityType: 'PRODUCT', entityId: read.productId, externalId: verdict.parentExternalId,
      summary: outcome.held
        ? `Mintsoft parent SKU ${read.sku} NOT deleted: the outbound-write hold refused it.`
        : `Mintsoft refused to delete parent SKU ${read.sku}.`,
      error: outcome.message,
      triggeredBy: context.triggeredBy,
    })
    return outcome.held ? 'held' : 'refused'
  }
  // Mintsoft confirmed. Drop the parent's link so the next run does not offer it again.
  await db.wmsProductLink.deleteMany({ where: { connector: 'mintsoft', productId: read.productId, externalProductId: verdict.parentExternalId } })
  await recordWmsMutationEvent({
    connector: 'mintsoft', direction: 'OUTBOUND', action: 'parent_sku_delete', outcome: 'SUCCEEDED',
    entityType: 'PRODUCT', entityId: read.productId, externalId: verdict.parentExternalId,
    summary: `Mintsoft parent SKU ${read.sku} deleted (variable product; ${verdict.replacements} variation${verdict.replacements === 1 ? '' : 's'} confirmed).`,
    before: { sku: read.sku, externalProductId: verdict.parentExternalId },
    triggeredBy: context.triggeredBy,
  })
  return 'deleted'
}

/**
 * The pass: for every VARIABLE product holding a Mintsoft link, decide from a fresh read, decide AGAIN just before the call, and delete
 * or refuse. Returns null when the setting is off (nothing was read, nothing was done).
 */
export async function runMintsoftParentSkuDeletionPass(input: { since: Date; triggeredBy: string }): Promise<ParentDeletionCounters | null> {
  if (!(await readMintsoftParentSkuDeleteEnabled())) return null
  const counters: ParentDeletionCounters = { considered: 0, deleted: 0, refused: 0, shadowed: 0, held: 0, errors: 0 }
  const parents = await db.product.findMany({
    where: { type: 'VARIABLE', wmsProductLinks: { some: { connector: 'mintsoft' } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  const context: ParentDeletionContext = { connector: getWmsConnector('mintsoft'), since: input.since, triggeredBy: input.triggeredBy }

  for (const { id } of parents) {
    counters.considered += 1
    try {
      const first = await readParent(id)
      if (!first) continue
      const firstVerdict = decideParentSkuDeletion(first, input.since)
      if (firstVerdict.kind === 'refuse') {
        await recordRefusal(first, firstVerdict.reasons, input.triggeredBy)
        counters.refused += 1
        continue
      }
      // The window between the first read and the call is narrowed, not closed: read again, and the verdict must still be the same.
      const second = await readParent(id)
      const secondVerdict = second ? decideParentSkuDeletion(second, input.since) : null
      if (!second || !secondVerdict || secondVerdict.kind === 'refuse' || secondVerdict.parentExternalId !== firstVerdict.parentExternalId) {
        await recordRefusal(first, second && secondVerdict?.kind === 'refuse' ? secondVerdict.reasons : ['the stored links changed while the deletion was being decided'], input.triggeredBy)
        counters.refused += 1
        continue
      }
      counters[await deleteConfirmedParent(second, secondVerdict, context)] += 1
    } catch (error) {
      // An error is a refusal to guess: nothing further is done for this parent and the pass goes on to the next.
      counters.errors += 1
      await recordWmsMutationEvent({
        connector: 'mintsoft', direction: 'OUTBOUND', action: 'parent_sku_delete', outcome: 'FAILED',
        entityType: 'PRODUCT', entityId: id, summary: 'Mintsoft parent SKU deletion failed before it was confirmed.',
        error: error instanceof Error ? error.message : 'parent SKU deletion failed', triggeredBy: input.triggeredBy,
      })
    }
  }
  await logActivity({
    entityType: 'SYSTEM', tag: 'sync', action: 'mintsoft_parent_sku_delete_pass',
    description: `Mintsoft parent SKU deletion: ${counters.considered} parents considered, ${counters.deleted} deleted, ${counters.refused} refused, ${counters.shadowed} shadowed, ${counters.held} held, ${counters.errors} errors.`,
    metadata: { ...counters }, resolveUser: false,
  })
  return counters
}
