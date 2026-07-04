'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { validateHsCode, isApprovableHsValidation } from '@/lib/trade/hs-validate'
import type { HsCodeProposalStatus } from '@/app/generated/prisma/client'
import { upsertHsCodeProposal } from '@/lib/trade/hs-proposal-service'

export type HsProposalRow = {
  id: string
  productId: string
  sku: string
  productName: string
  proposedHsCode: string | null
  proposedCustomsDescription: string | null
  source: string
  modelConfidence: number
  confidence: number
  band: string
  flags: string[]
  writeBlocking: boolean
  declarable: boolean
  reasoning: string
  status: HsCodeProposalStatus
  createdAt: string
}

export type HsProposalActionResult = { success: boolean; error?: string }

function toRow(p: {
  id: string
  productId: string
  proposedHsCode: string | null
  proposedCustomsDescription: string | null
  source: string
  modelConfidence: number
  confidence: number
  band: string
  flags: string
  writeBlocking: boolean
  declarable: boolean
  reasoning: string
  status: HsCodeProposalStatus
  createdAt: Date
  product: { sku: string; name: string }
}): HsProposalRow {
  return {
    id: p.id,
    productId: p.productId,
    sku: p.product.sku,
    productName: p.product.name,
    proposedHsCode: p.proposedHsCode,
    proposedCustomsDescription: p.proposedCustomsDescription,
    source: p.source,
    modelConfidence: p.modelConfidence,
    confidence: p.confidence,
    band: p.band,
    flags: p.flags ? p.flags.split(',') : [],
    writeBlocking: p.writeBlocking,
    declarable: p.declarable,
    reasoning: p.reasoning,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  }
}

/** List proposals for the review queue, lowest deterministic confidence first (most to review). */
export async function listHsCodeProposals(status: HsCodeProposalStatus = 'PENDING'): Promise<HsProposalRow[]> {
  await requirePermission('inventory.edit')
  const rows = await db.hsCodeProposal.findMany({
    where: { status },
    orderBy: [{ confidence: 'asc' }, { createdAt: 'asc' }],
    include: { product: { select: { sku: true, name: true } } },
    take: 500,
  })
  return rows.map(toRow)
}

/**
 * Classify a product's HS code (classifier + deterministic validator) and upsert a PENDING
 * proposal for review. One PENDING proposal per product — a re-classification replaces it.
 * Called ad-hoc from the UI and in bulk by the background sweep (6igm.4).
 */
export async function proposeHsCodeForProduct(productId: string): Promise<HsProposalRow | null> {
  await requirePermission('inventory.edit')
  const saved = await upsertHsCodeProposal(productId)
  if (!saved) return null
  revalidatePath('/trade/hs-code-review')
  return toRow(saved)
}

const ApproveSchema = z.object({
  proposalId: z.string().min(1),
  hsCode: z.string().optional(),
  reviewNote: z.string().optional(),
})

/**
 * Approve a proposal, writing the authoritative HS code to the product. Approve writes ONLY the
 * HS code — the customs description is owned by the WC import path (bhdm.1/.2), not this queue.
 *
 * FAIL-CLOSED: the code actually being committed — the operator's edit if present, else the
 * proposed code — is re-validated; approval is refused unless it is strictly declarable with no
 * write-blocking flag (never trust the stored `declarable`, the operator may have edited).
 *
 * The PENDING→APPROVED transition is atomic (updateMany guarded on status inside a transaction),
 * so concurrent approves/rejects can't both win: the product HS code is written only for the
 * request that actually flips the status.
 */
export async function approveHsCodeProposal(input: unknown): Promise<HsProposalActionResult> {
  const session = await requirePermission('inventory.edit')
  const { proposalId, hsCode, reviewNote } = ApproveSchema.parse(input)

  const proposal = await db.hsCodeProposal.findUnique({
    where: { id: proposalId },
    include: { product: { select: { id: true, name: true, customsDescription: true, category: { select: { name: true } } } } },
  })
  if (!proposal || proposal.status !== 'PENDING') {
    return { success: false, error: 'Proposal not found or already reviewed.' }
  }

  const finalCode = hsCode !== undefined ? hsCode : proposal.proposedHsCode
  const validation = validateHsCode({
    cnCode: finalCode,
    customsDescription: proposal.product.customsDescription, // for scoring only; not written
    name: proposal.product.name,
    categoryPath: proposal.product.category?.name ?? null,
  })
  if (!isApprovableHsValidation(validation)) {
    const why = validation.writeBlockingFlags.join(', ') || 'not a declarable 2026 CN8 (must be exactly 8 digits, present in the EU CN list)'
    return { success: false, error: `Cannot approve: ${why}.` }
  }

  let won = false
  await db.$transaction(async (tx) => {
    const transitioned = await tx.hsCodeProposal.updateMany({
      where: { id: proposalId, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        proposedHsCode: validation.normalizedCode,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      },
    })
    if (transitioned.count === 0) return // lost the race — another request already reviewed it; write nothing
    won = true
    await tx.product.update({ where: { id: proposal.productId }, data: { hsCode: validation.normalizedCode } })
  })

  if (!won) {
    return { success: false, error: 'Proposal was already reviewed by another request.' }
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: proposal.productId,
    action: 'hs_code_approved',
    tag: 'trade',
    description: `Approved HS code ${validation.normalizedCode} for ${proposal.product.name}`,
    metadata: { proposalId, hsCode: validation.normalizedCode },
  })

  revalidatePath('/trade/hs-code-review')
  revalidatePath('/inventory')
  return { success: true }
}

const RejectSchema = z.object({
  proposalId: z.string().min(1),
  reviewNote: z.string().optional(),
})

/** Reject a proposal without touching the product. */
export async function rejectHsCodeProposal(input: unknown): Promise<HsProposalActionResult> {
  const session = await requirePermission('inventory.edit')
  const { proposalId, reviewNote } = RejectSchema.parse(input)

  const proposal = await db.hsCodeProposal.findUnique({
    where: { id: proposalId },
    include: { product: { select: { name: true } } },
  })
  if (!proposal || proposal.status !== 'PENDING') {
    return { success: false, error: 'Proposal not found or already reviewed.' }
  }

  // Atomic PENDING→REJECTED so a concurrent approve can't also land.
  const transitioned = await db.hsCodeProposal.updateMany({
    where: { id: proposalId, status: 'PENDING' },
    data: { status: 'REJECTED', reviewedBy: session.user.id, reviewedAt: new Date(), reviewNote: reviewNote || null },
  })
  if (transitioned.count === 0) {
    return { success: false, error: 'Proposal was already reviewed by another request.' }
  }

  await logActivity({
    entityType: 'PRODUCT',
    entityId: proposal.productId,
    action: 'hs_code_rejected',
    tag: 'trade',
    description: `Rejected HS code proposal ${proposal.proposedHsCode ?? '(none)'} for ${proposal.product.name}`,
    metadata: { proposalId },
  })

  revalidatePath('/trade/hs-code-review')
  return { success: true }
}
