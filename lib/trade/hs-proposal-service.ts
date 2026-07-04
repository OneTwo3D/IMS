/**
 * HS-code proposal service (6igm.3/6igm.4) — the non-authenticated core shared by the review-queue
 * server action (proposeHsCodeForProduct, which adds the RBAC check) and the background sweep
 * (runHsClassificationSweep, which runs under cron auth). Classifies a product with the classifier
 * (6igm.1) + deterministic validator (6igm.2) and upserts the single PENDING proposal for review.
 */
import { db } from '@/lib/db'
import { Prisma } from '@/app/generated/prisma/client'
import { classifyHsCode } from '@/lib/trade/hs-classifier'
import { validateHsCode } from '@/lib/trade/hs-validate'

const PROPOSAL_INCLUDE = { product: { select: { sku: true, name: true } } } as const

export type HsCodeProposalWithProduct = Prisma.HsCodeProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>

/**
 * Classify a product and upsert its PENDING proposal. Create-first so it can never resurrect an
 * already-reviewed proposal: if a PENDING row exists the partial unique index raises P2002 and we
 * update that row in place (WHERE status='PENDING'); otherwise a fresh PENDING row is created.
 * Returns null if the product no longer exists (or the pending row was reviewed mid-flight).
 */
export async function upsertHsCodeProposal(productId: string): Promise<HsCodeProposalWithProduct | null> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      description: true,
      customsDescription: true,
      category: { select: { name: true } },
    },
  })
  if (!product) return null

  const categoryPath = product.category?.name ?? null
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
    status: 'PENDING' as const,
  }

  try {
    return await db.hsCodeProposal.create({ data: { productId, ...data }, include: PROPOSAL_INCLUDE })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    await db.hsCodeProposal.updateMany({ where: { productId, status: 'PENDING' }, data })
    return db.hsCodeProposal.findFirst({ where: { productId, status: 'PENDING' }, include: PROPOSAL_INCLUDE })
  }
}
