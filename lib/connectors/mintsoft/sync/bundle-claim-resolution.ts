import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { recordWmsMutationEvent } from '@/lib/domain/wms/mutation-audit'
import {
  bundleAbsentAuditText,
  isBundleSentClaimValue,
} from './bundle-create-outcome'

/**
 * THE OPERATOR'S WAY OUT OF A KEPT BUNDLE-CREATE CLAIM.
 *
 * A claim whose create may have reached Mintsoft (see bundle-create-outcome.ts) is never released by the
 * clock or by a lookup that found nothing. Without a way out that strands the bundle, so an operator who
 * has LOOKED IN MINTSOFT can resolve it in one of two ways, each tied to the exact claim the page showed
 * (its id AND its value, so a page that has gone stale resolves nothing):
 *
 *  - LINK: the bundle exists. The claim becomes the link to that Mintsoft id, with no checksum, so the next
 *    bundle check compares it with IMS like any other link (and raises the usual conflict if it differs).
 *  - ABSENT: the operator states that no bundle exists. The claim is released. That is the operator's
 *    statement and nothing IMS verified: it is recorded as such, and if it is wrong the next sync creates a
 *    second bundle.
 *
 * Both write an activity entry and an audit row naming the user, the claim and the product.
 */

export type KeptBundleClaim = {
  id: string
  productId: string
  sku: string
  name: string
  /** The claim's stored value: the page sends it back so a resolution is bound to the claim it displayed. */
  claimValue: string
  claimedAt: string
}

export async function listKeptBundleClaims(): Promise<KeptBundleClaim[]> {
  const rows = await db.wmsBundleLink.findMany({
    where: { connector: 'mintsoft', externalBundleId: { startsWith: 'pending:sent:' } },
    orderBy: [{ updatedAt: 'asc' }],
    take: 50,
    select: { id: true, externalBundleId: true, updatedAt: true, product: { select: { id: true, sku: true, name: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    productId: row.product.id,
    sku: row.product.sku,
    name: row.product.name,
    claimValue: row.externalBundleId,
    claimedAt: row.updatedAt.toISOString(),
  }))
}

export type KeptBundleClaimResolution =
  | { kind: 'link'; externalBundleId: string }
  | { kind: 'absent' }

export type KeptBundleClaimResult = { success: true; message: string } | { success: false; error: string }

const STALE_PAGE = 'That claim has changed or been resolved since this page was loaded; nothing was changed. Reload the page.'

export async function resolveKeptBundleClaim(input: {
  claimId: string
  claimValue: string
  resolution: KeptBundleClaimResolution
  userId: string
}): Promise<KeptBundleClaimResult> {
  if (!isBundleSentClaimValue(input.claimValue)) return { success: false, error: STALE_PAGE }

  const link = await db.wmsBundleLink.findUnique({
    where: { id: input.claimId },
    select: { id: true, connector: true, productId: true, externalBundleId: true, product: { select: { sku: true } } },
  })
  if (!link || link.connector !== 'mintsoft' || link.externalBundleId !== input.claimValue) return { success: false, error: STALE_PAGE }
  const sku = link.product.sku

  if (input.resolution.kind === 'link') {
    const externalBundleId = input.resolution.externalBundleId.trim()
    if (!/^\d{1,15}$/.test(externalBundleId)) {
      return { success: false, error: 'A Mintsoft bundle id is a whole number, for example 12345. Nothing was changed.' }
    }
    const changed = await db.wmsBundleLink.updateMany({
      where: { id: link.id, externalBundleId: input.claimValue },
      data: { externalBundleId, checksum: null, lastSyncedAt: null },
    })
    if (changed.count !== 1) return { success: false, error: STALE_PAGE }
    await recordResolution({ link, sku, userId: input.userId, summary: `Operator linked the kept Mintsoft bundle create for ${sku} to Mintsoft bundle ${externalBundleId}`, externalId: externalBundleId, after: { externalBundleId } })
    return { success: true, message: `Linked ${sku} to Mintsoft bundle ${externalBundleId}. The next bundle check compares it with IMS.` }
  }

  const released = await db.wmsBundleLink.deleteMany({ where: { id: link.id, externalBundleId: input.claimValue } })
  if (released.count !== 1) return { success: false, error: STALE_PAGE }
  await recordResolution({ link, sku, userId: input.userId, summary: bundleAbsentAuditText(sku), externalId: null, after: { released: true, operatorStatement: 'no bundle found in Mintsoft', verifiedByIms: false } })
  return { success: true, message: `Released the claim on ${sku}. The next bundle sync may create the bundle.` }
}

async function recordResolution(params: {
  link: { id: string; productId: string }
  sku: string
  userId: string
  summary: string
  externalId: string | null
  after: Record<string, unknown>
}): Promise<void> {
  await recordWmsMutationEvent({
    connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_claim_resolved', outcome: 'SUCCEEDED',
    entityType: 'PRODUCT', entityId: params.link.productId, externalId: params.externalId,
    summary: params.summary,
    before: { claimId: params.link.id },
    after: { ...params.after, claimId: params.link.id, userId: params.userId },
  })
  await logActivity({
    entityType: 'SYSTEM',
    entityId: params.link.productId,
    tag: 'sync',
    action: 'mintsoft_bundle_claim_resolved',
    description: params.summary,
    metadata: { claimId: params.link.id, productId: params.link.productId, sku: params.sku, userId: params.userId, ...params.after },
    resolveUser: false,
  })
}
