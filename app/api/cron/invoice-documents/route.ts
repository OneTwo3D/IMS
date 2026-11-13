import { verifyCron } from '@/lib/cron-auth'
import { enforceCronRateLimit } from '@/lib/cron-rate-limit'
import { getMaintenanceModeResponse } from '@/lib/maintenance-mode'
import { runCronWithLogging } from '@/lib/ops/cron-run'
import { runInvoiceDocumentSweep } from '@/lib/domain/invoice-documents/sweep'
import { getInvoiceDocumentHealth } from '@/lib/domain/invoice-documents/health'
import { xeroInvoiceDocumentDeps } from '@/lib/connectors/xero/invoice-document-deps'
import { cronRunResponse } from '@/lib/ops/cron-response'
import { cronOutcome } from '@/lib/ops/cron-outcomes'

export const runtime = 'nodejs'

// Called by cron with Authorization: Bearer $CRON_SECRET. Read-only toward every vendor: it GETs invoice and credit note
// PDFs from the accounting ledger and stores them in IMS. It writes nothing to the ledger and nothing to the storefront.
export async function GET(request: Request) {
  const cronErr = await verifyCron(request)
  if (cronErr) return cronErr
  const rateLimitErr = await enforceCronRateLimit('invoice-documents', { request })
  if (rateLimitErr) return rateLimitErr
  const maintenance = await getMaintenanceModeResponse('cron')
  if (maintenance) return maintenance

  const { runId, result, outcomeClass, responseStatus } = await runCronWithLogging({
    jobName: 'invoice-documents',
    run: async () => ({ ...(await runInvoiceDocumentSweep(xeroInvoiceDocumentDeps())), health: await getInvoiceDocumentHealth() }),
    getOutcome: (outcome) => ({
      counts: { considered: outcome.considered, stored: outcome.stored, waiting: outcome.waiting, needsAttention: outcome.needsAttention, failed: outcome.failed, needsAttentionTotal: outcome.health.needsAttention, pendingTotal: outcome.health.pending },
      // The recorded status and the response both come from the mapping (lib/ops/cron-outcomes.ts), so they cannot disagree.
      statusReason: outcome.stoppedEarly ?? (outcome.failed > 0 ? `${outcome.failed} document(s) failed` : outcome.skipped ? `skipped: ${outcome.skipped}` : null),
    }),
    outcomeOf: (result) => cronOutcome('invoice-documents', result),
  })

  return cronRunResponse({ runId, result, outcomeClass, responseStatus })
}
