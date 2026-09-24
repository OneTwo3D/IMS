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

  // o3d-j625 r10 (Codex round 9, HIGH) — BEFORE THE CONNECTOR GATES, DELIBERATELY.
  //
  // These are refusals a business transaction could not record because another transaction held the
  // posting key; they are replayed here, from the pool, where waiting for that key is allowed. Nearly all
  // of them exist BECAUSE the accounting connector is retired, switched or unconfigured — which is
  // exactly when every branch below returns `skipped`. Draining inside one of those branches would gate
  // the reconciler off in the situations that produce its work, so it runs on every tick regardless of
  // which connector, if any, is enabled. It touches no connector and makes no remote call.
  const provisionalPostingRefusals = await reconcileProvisionalRefusals()

  // Dispatch to the active accounting connector
  if (await isIntegrationPluginEnabled('xero')) {
    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'Xero sync disabled', provisionalPostingRefusals })
    }
    if (!(await isAccountingConnectorConnected('xero'))) {
      return NextResponse.json({ skipped: true, reason: 'Xero not connected', provisionalPostingRefusals })
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
    return NextResponse.json({ ...result, backReferenceRepair, creditNoteAllocationReenqueue, landedCostJournalOutbox, provisionalPostingRefusals })
  }

  if (await isIntegrationPluginEnabled('quickbooks')) {
    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks sync disabled', provisionalPostingRefusals })
    }
    if (!(await isAccountingConnectorConnected('quickbooks'))) {
      return NextResponse.json({ skipped: true, reason: 'QuickBooks not connected', provisionalPostingRefusals })
    }
    // audit-grob: same backstop drain — the landed-cost journals are
    // connector-agnostic (queueAccountingSync routes to the active connector), so
    // they must drain under QuickBooks too, not just Xero.
    const landedCostJournalOutbox = await drainLandedCostJournalOutbox()
    const { processPendingQuickBooksSync } = await import('@/lib/connectors/quickbooks/sync-processor')
    const result = await processPendingQuickBooksSync()
    // NO back-reference repair sweep in this branch, and that asymmetry with Xero above is
    // DELIBERATE (o3d-9kek r6). The sweep's candidate query is scoped by connector alone, and a
    // QuickBooks external id is only meaningful inside one realm — after a reconnect to a different
    // company it would write a retired realm's id onto a live document, which the payment poller
    // then acts on as if it were current. Failing to repair is acceptable; repairing onto the wrong
    // document is not.
    //
    // THE PRECONDITION THIS LINE USED TO NAME IS THE WRONG ONE (o3d-0bfh r6, Codex MEDIUM). It said
    // o3d-s36z (connector-tenant isolation); that CLOSED on 2026-08-21, a row's realm IS recorded
    // now, and a maintainer following this line would have found the condition satisfied and made
    // the one-line binding — re-enqueueing a realm-local integer against the wrong company. The real
    // prerequisites are POST-TIME AUTHORIZATION (o3d-8prh: this connector does not carry the
    // connection verdict to the last statement before the socket) and ORIGIN PROPAGATION (the
    // follow-up rows a sweep creates here record no connectionProvenance for that check to read).
    // The order of work is at the end of lib/connectors/quickbooks/sync-processor.ts.
    return NextResponse.json({ ...result, landedCostJournalOutbox, provisionalPostingRefusals })
  }

  return NextResponse.json({ skipped: true, reason: 'No accounting plugin enabled', provisionalPostingRefusals })
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

// o3d-j625 r10: replay the refusals that could not take their posting key inside a caller's
// transaction. Never allowed to fail the tick — a drain outage must not stop the sync queue — and a
// failure leaves the claims PENDING, which the exception inbox surfaces past its grace.
async function reconcileProvisionalRefusals(): Promise<Awaited<ReturnType<typeof import('@/lib/domain/accounting/posting-refusal-reconcile')['reconcileProvisionalPostingRefusals']>> | undefined> {
  try {
    const { reconcileProvisionalPostingRefusals } = await import('@/lib/domain/accounting/posting-refusal-reconcile')
    return await reconcileProvisionalPostingRefusals()
  } catch (reconcileError) {
    console.error('accounting-sync cron: provisional posting-refusal reconciliation failed', reconcileError)
    return undefined
  }
}
