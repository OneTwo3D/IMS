/**
 * HS-code proposal service (6igm.3/6igm.4) — the non-authenticated core shared by the review-queue
 * server action (proposeHsCodeForProduct, which adds the RBAC check) and the background sweep
 * (runHsClassificationSweep, which runs under cron auth). Classifies a product with the classifier
 * (6igm.1) + deterministic validator (6igm.2) and upserts the single PENDING proposal for review.
 */
import { db } from '@/lib/db'
import { Prisma, ProductType, ProductLifecycleStatus } from '@/app/generated/prisma/client'
import { classifyHsCode } from '@/lib/trade/hs-classifier'
import { validateHsCode } from '@/lib/trade/hs-validate'
import { hsClassificationFieldsHash, shouldSkipHsReclassification } from '@/lib/trade/hs-classification-fields'

const PROPOSAL_INCLUDE = { product: { select: { sku: true, name: true } } } as const

/** Product types the classifier applies to — physical goods only (matches the sweep filter). */
const ELIGIBLE_TYPES: ProductType[] = [ProductType.SIMPLE, ProductType.VARIANT, ProductType.KIT, ProductType.BOM]

export type HsCodeProposalWithProduct = Prisma.HsCodeProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>

/**
 * Classify a product and upsert its PENDING proposal. Create-first so it can never resurrect an
 * already-reviewed proposal: if a PENDING row exists the partial unique index raises P2002 and we
 * update that row in place (WHERE status='PENDING'); otherwise a fresh PENDING row is created.
 * Returns null if the product no longer exists (or the pending row was reviewed mid-flight).
 */
export async function upsertHsCodeProposal(
  productId: string,
  { force = false }: { force?: boolean } = {},
): Promise<HsCodeProposalWithProduct | null> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      description: true,
      customsDescription: true,
      type: true,
      lifecycleStatus: true,
      category: { select: { name: true } },
    },
  })
  if (!product) return null
  // Only classify eligible, non-archived products — a VARIABLE parent or NON_INVENTORY item is not
  // classifiable. Defence-in-depth: the sweep already filters, but this guards direct callers too.
  if (!ELIGIBLE_TYPES.includes(product.type) || product.lifecycleStatus === ProductLifecycleStatus.ARCHIVED) {
    return null
  }

  const categoryPath = product.category?.name ?? null
  const fieldsHash = hsClassificationFieldsHash({
    name: product.name,
    description: product.description,
    categoryPath,
  })

  // 6igm.5: if a PENDING proposal already reflects the current classification-relevant fields,
  // don't re-bill the API on a routine re-run (the sweep or an unchanged save). `force` (the
  // Re-classify button) bypasses this. This also prevents two overlapping sweeps double-classifying.
  const existing = await db.hsCodeProposal.findFirst({
    where: { productId, status: 'PENDING' },
    select: { id: true, classificationFieldsHash: true },
  })
  if (existing && shouldSkipHsReclassification(existing.classificationFieldsHash, fieldsHash, force)) {
    return db.hsCodeProposal.findUnique({ where: { id: existing.id }, include: PROPOSAL_INCLUDE })
  }

  const classification = await classifyHsCode({
    name: product.name,
    description: product.description,
    categoryPath,
  })
  const validation = validateHsCode({
    cnCode: classification.cnCode,
    customsDescription: product.customsDescription,
    name: product.name,
    categoryPath,
  })

  const data = {
    proposedHsCode: classification.cnCode,
    proposedCustomsDescription: product.customsDescription,
    source: classification.source,
    modelConfidence: classification.modelConfidence,
    confidence: validation.confidence,
    band: validation.band,
    flags: validation.flags.join(','),
    writeBlocking: validation.writeBlockingFlags.length > 0,
    declarable: validation.declarable,
    reasoning: classification.reasoning || validation.notes,
    classificationFieldsHash: fieldsHash,
    status: 'PENDING' as const,
  }

  if (existing) {
    return db.hsCodeProposal.update({ where: { id: existing.id }, data, include: PROPOSAL_INCLUDE })
  }
  try {
    return await db.hsCodeProposal.create({ data: { productId, ...data }, include: PROPOSAL_INCLUDE })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    await db.hsCodeProposal.updateMany({ where: { productId, status: 'PENDING' }, data })
    return db.hsCodeProposal.findFirst({ where: { productId, status: 'PENDING' }, include: PROPOSAL_INCLUDE })
  }
}
