import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity-log'
import { requireApiAdmin } from '@/lib/auth/server'
import { updateAccountingReconciliationFindingStatus } from '@/lib/domain/accounting/reconciliation'

export const runtime = 'nodejs'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const { id } = await context.params
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  try {
    const { finding, priorStatus } = await updateAccountingReconciliationFindingStatus(id, body.status, session.user.id)
    await logActivity({
      entityType: 'AccountingReconciliationFinding',
      entityId: finding.id,
      tag: 'accounting',
      action: 'accounting_reconciliation_finding_status',
      description: `Marked accounting reconciliation finding ${finding.id} from ${priorStatus} to ${finding.status}`,
      metadata: {
        findingId: finding.id,
        runId: finding.runId,
        priorStatus,
        status: finding.status,
        actorUserId: session.user.id,
        code: finding.code,
      },
    })
    return NextResponse.json({ finding }, {
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update finding status.' },
      { status: 400 },
    )
  }
}
