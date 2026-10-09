import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { buildWmsMutationEventRow } from '@/lib/domain/wms/mutation-audit'
import { lookupMintsoftBundle } from '@/lib/connectors/mintsoft/api/client'
import {
  bundleAbsentAuditText,
  bundleReleaseLookupRefusalText,
  bundleReleaseTooSoonText,
  bundleReleaseWindowMinutes,
  currentBundleCreateInFlightWindowMs,
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
 *    statement and nothing IMS verified, so it is REFUSED unless two things IMS can check hold: the create was
 *    sent longer ago than any request can stay in flight (a release while the PUT may still be travelling lets a
 *    second create go out over it), AND a fresh lookup, made now, returns a readable "no bundle". Anything else
 *    changes nothing and says why.
 *
 * The claim transition and a durable audit row commit in ONE transaction: if the audit cannot be written the claim
 * is not released or linked. (An activity-log entry is added after the commit, best effort.)
 */

export const KEPT_BUNDLE_CLAIMS_PAGE_SIZE = 25

export type KeptBundleClaim = {
  id: string
  productId: string
  sku: string
  name: string
  /** The claim's stored value: the page sends it back so a resolution is bound to the claim it displayed. */
  claimValue: string
  claimedAt: string
  /** When "no bundle" may be stated: before this the action refuses. */
  releasableAt: string
  /** Set while a release would be refused for being too early; the one sentence the page shows. */
  releaseBlockedReason: string | null
}

export type KeptBundleClaimPage = {
  claims: KeptBundleClaim[]
  total: number
  page: number
  pageSize: number
  query: string
}

export async function listKeptBundleClaims(options: { page?: number; query?: string; now?: number } = {}): Promise<KeptBundleClaimPage> {
  const page = Math.max(0, Math.floor(options.page ?? 0))
  const query = (options.query ?? '').trim().slice(0, 100)
  const now = options.now ?? Date.now()
  const windowMs = currentBundleCreateInFlightWindowMs()
  const minutes = bundleReleaseWindowMinutes(windowMs)
  const where = {
    connector: 'mintsoft',
    externalBundleId: { startsWith: 'pending:' },
    NOT: { externalBundleId: { startsWith: 'pending:unsent:' } },
    ...(query ? { product: { sku: { contains: query, mode: 'insensitive' as const } } } : {}),
  }
  const [total, rows] = await Promise.all([
    db.wmsBundleLink.count({ where }),
    db.wmsBundleLink.findMany({
      where,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      skip: page * KEPT_BUNDLE_CLAIMS_PAGE_SIZE,
      take: KEPT_BUNDLE_CLAIMS_PAGE_SIZE,
      select: { id: true, externalBundleId: true, updatedAt: true, product: { select: { id: true, sku: true, name: true } } },
    }),
  ])
  return {
    claims: rows.map((row) => {
      const releasableAt = row.updatedAt.getTime() + windowMs
      return {
        id: row.id,
        productId: row.product.id,
        sku: row.product.sku,
        name: row.product.name,
        claimValue: row.externalBundleId,
        claimedAt: row.updatedAt.toISOString(),
        releasableAt: new Date(releasableAt).toISOString(),
        releaseBlockedReason: releasableAt > now ? bundleReleaseTooSoonText(minutes) : null,
      }
    }),
    total,
    page,
    pageSize: KEPT_BUNDLE_CLAIMS_PAGE_SIZE,
    query,
  }
}

export type KeptBundleClaimResolution =
  | { kind: 'link'; externalBundleId: string }
  | { kind: 'absent' }

export type KeptBundleClaimResult = { success: true; message: string } | { success: false; error: string }

const STALE_PAGE = 'That claim has changed or been resolved since this page was loaded; nothing was changed. Reload the page.'
const AUDIT_FAILED = 'Nothing was changed: the audit record of this decision could not be saved, and a decision is not made without one. Try again.'

class ClaimChanged extends Error {}

export async function resolveKeptBundleClaim(input: {
  claimId: string
  claimValue: string
  resolution: KeptBundleClaimResolution
  userId: string
  now?: number
  /** The in-flight window to enforce; defaults to the one derived from the connector's timeout. */
  inFlightWindowMs?: number
}): Promise<KeptBundleClaimResult> {
  if (!isBundleSentClaimValue(input.claimValue)) return { success: false, error: STALE_PAGE }

  const link = await db.wmsBundleLink.findUnique({
    where: { id: input.claimId },
    select: { id: true, connector: true, productId: true, externalBundleId: true, updatedAt: true, product: { select: { sku: true } } },
  })
  if (!link || link.connector !== 'mintsoft' || link.externalBundleId !== input.claimValue) return { success: false, error: STALE_PAGE }
  const sku = link.product.sku

  if (input.resolution.kind === 'link') {
    const externalBundleId = input.resolution.externalBundleId.trim()
    if (!/^\d{1,15}$/.test(externalBundleId)) {
      return { success: false, error: 'A Mintsoft bundle id is a whole number, for example 12345. Nothing was changed.' }
    }
    return commit({
      link, sku, userId: input.userId,
      summary: `Operator linked the kept Mintsoft bundle create for ${sku} to Mintsoft bundle ${externalBundleId}`,
      externalId: externalBundleId,
      after: { externalBundleId },
      transition: (tx) => tx.wmsBundleLink.updateMany({
        where: { id: link.id, externalBundleId: input.claimValue },
        data: { externalBundleId, checksum: null, lastSyncedAt: null },
      }),
      success: `Linked ${sku} to Mintsoft bundle ${externalBundleId}. The next bundle check compares it with IMS.`,
    })
  }

  // ABSENT. First the clock: a create may still be in flight.
  const now = input.now ?? Date.now()
  const windowMs = input.inFlightWindowMs ?? currentBundleCreateInFlightWindowMs()
  const cutoff = new Date(now - windowMs)
  if (link.updatedAt.getTime() > cutoff.getTime()) {
    return { success: false, error: bundleReleaseTooSoonText(bundleReleaseWindowMinutes(windowMs)) }
  }
  // Then a fresh lookup, made now: only a readable "no bundle" allows the release.
  const parent = await db.wmsProductLink.findFirst({ where: { productId: link.productId, connector: 'mintsoft' }, select: { externalProductId: true } })
  if (!parent) return { success: false, error: bundleReleaseLookupRefusalText('no-product-link') }
  let verdict: Awaited<ReturnType<typeof lookupMintsoftBundle>>
  try {
    verdict = await lookupMintsoftBundle(parent.externalProductId)
  } catch (error) {
    return { success: false, error: bundleReleaseLookupRefusalText('failed', error instanceof Error ? error.message : undefined) }
  }
  if (verdict.kind === 'found') return { success: false, error: bundleReleaseLookupRefusalText('found', verdict.bundle.externalBundleId) }
  if (verdict.kind === 'unreadable') return { success: false, error: bundleReleaseLookupRefusalText('unreadable') }

  return commit({
    link, sku, userId: input.userId,
    summary: bundleAbsentAuditText(sku),
    externalId: null,
    after: { released: true, operatorStatement: 'no bundle found in Mintsoft', verifiedByIms: false, freshLookup: 'no bundle', inFlightWindowMinutes: bundleReleaseWindowMinutes(windowMs) },
    transition: (tx) => tx.wmsBundleLink.deleteMany({ where: { id: link.id, externalBundleId: input.claimValue, updatedAt: { lte: cutoff } } }),
    success: `Released the claim on ${sku}. The next bundle sync may create the bundle.`,
  })
}

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

async function commit(params: {
  link: { id: string; productId: string }
  sku: string
  userId: string
  summary: string
  externalId: string | null
  after: Record<string, unknown>
  transition: (tx: Tx) => Promise<{ count: number }>
  success: string
}): Promise<KeptBundleClaimResult> {
  try {
    await db.$transaction(async (tx) => {
      const changed = await params.transition(tx)
      if (changed.count !== 1) throw new ClaimChanged()
      // NOT best effort: if this row cannot be written the transaction rolls back and the claim stays.
      await tx.wmsMutationEvent.create({
        data: buildWmsMutationEventRow({
          connector: 'mintsoft', direction: 'OUTBOUND', action: 'bundle_claim_resolved', outcome: 'SUCCEEDED',
          entityType: 'PRODUCT', entityId: params.link.productId, externalId: params.externalId,
          summary: params.summary,
          before: { claimId: params.link.id },
          after: { ...params.after, claimId: params.link.id, userId: params.userId },
          triggeredBy: params.userId,
        }),
      })
    })
  } catch (error) {
    if (error instanceof ClaimChanged) return { success: false, error: STALE_PAGE }
    console.error('[mintsoft bundle claim] resolution not committed', error)
    return { success: false, error: AUDIT_FAILED }
  }
  await logActivity({
    entityType: 'SYSTEM',
    entityId: params.link.productId,
    tag: 'sync',
    action: 'mintsoft_bundle_claim_resolved',
    description: params.summary,
    metadata: { claimId: params.link.id, productId: params.link.productId, sku: params.sku, userId: params.userId, ...params.after },
    resolveUser: false,
  })
  return { success: true, message: params.success }
}
