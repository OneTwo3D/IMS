import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { db } from '@/lib/db'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { isAccountingConnectorConnected } from '@/lib/accounting'
import { cronResultResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

/** What a swallowed sweep failure becomes in the result: its message (a hold-refused write carries the hold's own text, which the exit status reads as held). */
const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)

export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('accounting-sync', { request })
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
  // Each sweep below is independent and keeps running when another fails, so a failure is CARRIED into the result as `errors`, not dropped.
  const sweepErrors: string[] = []
  const answer = (body: Record<string, unknown>) => {
    const withErrors = sweepErrors.length > 0 ? { ...body, errors: sweepErrors } : body
    return cronResultResponse(withErrors, { outcomeClass: cronOutcome('accounting-sync', withErrors as never) })
  }
  const provisional = await reconcileProvisionalRefusals()
  if (provisional.error) sweepErrors.push(provisional.error)
  const provisionalPostingRefusals = provisional.refusals

  // Dispatch to the active accounting connector
  if (await isIntegrationPluginEnabled('xero')) {
    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return answer({ skipped: true, reason: 'Xero sync disabled', provisionalPostingRefusals })
    }
    if (!(await isAccountingConnectorConnected('xero'))) {
      return answer({ skipped: true, reason: 'Xero not connected', provisionalPostingRefusals })
    }
    // audit-grob: drain the landed-cost adjustment-journal backstop FIRST so any
    // journals lost to a crash are re-queued (into AccountingSyncLog) in time for
    // this run's sync. Idempotent — a no-op when the direct call already queued them.
    const landedCostJournalOutbox = await drainLandedCostJournalOutbox(sweepErrors)
    const { processPendingXeroSync, repairXeroBackReferences, reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
    const result = await processPendingXeroSync()
    // audit-H3: repair any documents whose back-reference was never written
    // (process died after the connector post, or retries exhausted to FAILED).
    let backReferenceRepair: Awaited<ReturnType<typeof repairXeroBackReferences>> | undefined
    try {
      backReferenceRepair = await repairXeroBackReferences()
    } catch (repairError) {
      console.error('accounting-sync cron: back-reference repair sweep failed', repairError)
      sweepErrors.push(`Back-reference repair sweep failed: ${failureText(repairError)}`)
    }
    // audit-w77e: enqueue allocations for credit notes whose bill synced to Xero
    // only after the credit posted (the v08m enqueue is skipped in that window).
    let creditNoteAllocationReenqueue: Awaited<ReturnType<typeof reenqueueMissingCreditNoteAllocations>> | undefined
    try {
      creditNoteAllocationReenqueue = await reenqueueMissingCreditNoteAllocations()
    } catch (reenqueueError) {
      console.error('accounting-sync cron: credit-note allocation re-enqueue sweep failed', reenqueueError)
      sweepErrors.push(`Credit-note allocation re-enqueue sweep failed: ${failureText(reenqueueError)}`)
    }
    const body = { ...result, backReferenceRepair, creditNoteAllocationReenqueue, landedCostJournalOutbox, provisionalPostingRefusals }
    return answer(body)
  }

  // THE QUICKBOOKS BRANCH WAS HERE, AND IS ARCHIVED (o3d-remove-parked-connectors).
  //
  // It gated on plugin + `quickbooks_sync_enabled` + a stored token, drained the landed-cost journal
  // outbox and then ran `processPendingQuickBooksSync()`. Recoverable at
  // `git show archive/quickbooks-connector:app/api/cron/accounting-sync/route.ts`.
  //
  // IT DELIBERATELY RAN NO BACK-REFERENCE REPAIR SWEEP, and that asymmetry with Xero above was the
  // interesting part: the sweep's candidate query is scoped by connector alone, and a QuickBooks
  // external id is only meaningful inside one realm, so after a reconnect to a different company it
  // would have written a retired realm's id onto a live document. The two prerequisites it named —
  // POST-TIME AUTHORIZATION (o3d-8prh) and ORIGIN PROPAGATION — are what a second connector would
  // have to satisfy before its rows may be swept. See docs/archive/quickbooks-connector-removal.md.

  return answer({ skipped: true, reason: 'No accounting plugin enabled', provisionalPostingRefusals })
}

// audit-grob: drain the landed-cost adjustment-journal backstop. Called only from
// within a confirmed active+enabled connector branch, so queueAccountingSync (via
// the drainer) actually queues rather than no-opping (which would mark a job
// SUCCEEDED without posting — Codex review).
async function drainLandedCostJournalOutbox(sweepErrors: string[]): Promise<Awaited<ReturnType<typeof import('@/lib/domain/purchasing/landed-cost-journal-outbox')['processLandedCostJournalOutbox']>> | undefined> {
  try {
    const { processLandedCostJournalOutbox } = await import('@/lib/domain/purchasing/landed-cost-journal-outbox')
    return await processLandedCostJournalOutbox()
  } catch (outboxError) {
    console.error('accounting-sync cron: landed-cost journal outbox drain failed', outboxError)
    sweepErrors.push(`Landed-cost journal outbox drain failed: ${failureText(outboxError)}`)
    return undefined
  }
}

// o3d-j625 r10: replay the refusals that could not take their posting key inside a caller's
// transaction. Never allowed to fail the tick — a drain outage must not stop the sync queue — and a
// failure leaves the claims PENDING, which the exception inbox surfaces past its grace.
async function reconcileProvisionalRefusals(): Promise<{ refusals?: Awaited<ReturnType<typeof import('@/lib/domain/accounting/posting-refusal-reconcile')['reconcileProvisionalPostingRefusals']>>; error?: string }> {
  try {
    const { reconcileProvisionalPostingRefusals } = await import('@/lib/domain/accounting/posting-refusal-reconcile')
    return { refusals: await reconcileProvisionalPostingRefusals() }
  } catch (reconcileError) {
    console.error('accounting-sync cron: provisional posting-refusal reconciliation failed', reconcileError)
    return { error: `Provisional posting-refusal reconciliation failed: ${failureText(reconcileError)}` }
  }
}
