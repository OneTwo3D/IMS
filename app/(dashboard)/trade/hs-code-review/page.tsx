import type { Metadata } from 'next'
import { listHsCodeProposals } from '@/app/actions/hs-proposals'
import { HsReviewClient } from './hs-review-client'

export const metadata: Metadata = { title: 'HS Code Review' }

export default async function HsCodeReviewPage() {
  const proposals = await listHsCodeProposals('PENDING')
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">HS Code Review</h1>
        <p className="text-sm text-muted-foreground">
          Approve, edit, or reject AI-proposed 2026 EU CN codes before they become authoritative on the product.
          A code that is not a declarable CN8 cannot be approved.
        </p>
      </div>
      <HsReviewClient initialProposals={proposals} />
    </div>
  )
}
