import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/cron-auth'
import { CRON_RATE_LIMIT_FIVE_MINUTE_MAX, enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { isAccountingConnectorConnected } from '@/lib/accounting'

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-sync', { request, max: CRON_RATE_LIMIT_FIVE_MINUTE_MAX })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  // Dispatch to the active accounting connector
  if (await isIntegrationPluginEnabled('xero')) {
    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'Xero sync disabled' })
    }
    if (!(await isAccountingConnectorConnected('xero'))) {
      return NextResponse.json({ skipped: true, reason: 'Xero not connected' })
    }
    // audit-grob: drain the landed-cost adjustment-journal backstop FIRST so any
    // journals lost to a crash are re-queued (into AccountingSyncLog) in time for
    // this run's sync. Idempotent — a no-op when the direct call already queued them.
    const landedCostJournalOutbox = await drainLandedCostJournalOutbox()
    const { processPendingXeroSync, repairXeroBackReferences, reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
    const result = await processPendingXeroSync()
    // audit-H3: repair any documents whose back-reference was never written
    // (process died after the connector post, or retries exhausted to FAILED).
    let backReferenceRepair: Awaited<ReturnType<typeof repairXeroBackReferences>> | undefined
    try {
      backReferenceRepair = await repairXeroBackReferences()
    } catch (repairError) {
      console.error('accounting-sync cron: back-reference repair sweep failed', repairError)
    }
    // audit-w77e: enqueue allocations for credit notes whose bill synced to Xero
    // only after the credit posted (the v08m enqueue is skipped in that window).
    let creditNoteAllocationReenqueue: Awaited<ReturnType<typeof reenqueueMissingCreditNoteAllocations>> | undefined
    try {
      creditNoteAllocationReenqueue = await reenqueueMissingCreditNoteAllocations()
    } catch (reenqueueError) {
      console.error('accounting-sync cron: credit-note allocation re-enqueue sweep failed', reenqueueError)
    }
    return NextResponse.json({ ...result, backReferenceRepair, creditNoteAllocationReenqueue, landedCostJournalOutbox })
  }

  if (await isIntegrationPluginEnabled('quickbooks')) {
    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks sync disabled' })
    }
    if (!(await isAccountingConnectorConnected('quickbooks'))) {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks not connected' })
    }
    // audit-grob: same backstop drain — the landed-cost journals are
    // connector-agnostic (queueAccountingSync routes to the active connector), so
    // they must drain under QuickBooks too, not just Xero.
    const landedCostJournalOutbox = await drainLandedCostJournalOutbox()
    const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
    const result = await processPendingQuickBooksSync()
    return NextResponse.json({ ...result, landedCostJournalOutbox })
  }

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled' })
}

// audit-grob: drain the landed-cost adjustment-journal backstop. Called only from
// within a confirmed active+enabled connector branch, so queueAccountingSync (via
// the drainer) actually queues rather than no-opping (which would mark a job
// SUCCEEDED without posting — Codex review).
async function drainLandedCostJournalOutbox(): Promise<Awaited<ReturnType<typeof import('@/lib/domain/purchasing/landed-cost-journal-outbox')['processLandedCostJournalOutbox']>> | undefined> {
  try {
    const { processLandedCostJournalOutbox } = await import('@/lib/domain/purchasing/landed-cost-journal-outbox')
    return await processLandedCostJournalOutbox()
  } catch (outboxError) {
    console.error('accounting-sync cron: landed-cost journal outbox drain failed', outboxError)
    return undefined
  }
}
