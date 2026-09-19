/**
 * o3d-1xmo / o3d-2guf — WHICH LEDGER A DAILY-BATCH ROW WAS JOURNALED INTO.
 *
 * A daily-batch reference (`A1-<date>-<digest>`, `B-<date>-<digest>`) names a GROUP and a DATE, and
 * no ledger. Group A2 has recorded its connector per order since o3d-o97 r4
 * (`allocationBatchConnector`, and per pass in `allocationBatchPasses`). A1 and B had nothing, so after
 * a connector switch every reader assumed the connector that is active NOW:
 *
 *   • the recreate sweep of the new connector probed only its OWN ledger for the batch's log, found
 *     none, and rebuilt the old connector's batch into its own books — a duplicate deferral (A1) or a
 *     duplicate revenue recognition and COGS (B), while the original stood in the old books;
 *   • a refund debited Unearned Revenue in the new books, which never credited it, and left the real
 *     liability standing in the old ones.
 *
 * `SalesOrder.revenueDeferredConnector` and `Shipment.shipmentJournalConnector` now carry the ledger,
 * written by the connector's own batch writer in the same UPDATE as the stamp. These helpers are the one
 * reading of them, so the two connectors' sweeps and the refund cannot answer the question two ways.
 *
 * A NULL is a row staged before the column existed. It is UNATTRIBUTED, never assumed to be the
 * active connector: that assumption is the defect.
 */

/** How one staged row relates to the sweep (or refund) that is reading it. */
export type DailyBatchRowLedger =
  | { kind: 'own' }
  | { kind: 'foreign'; connector: string }
  | { kind: 'unattributed' }

export function classifyDailyBatchRowLedger(
  recorded: string | null | undefined,
  readerConnector: string,
): DailyBatchRowLedger {
  if (recorded == null || recorded === '') return { kind: 'unattributed' }
  return recorded === readerConnector ? { kind: 'own' } : { kind: 'foreign', connector: recorded }
}

/**
 * The run-error line for a batch whose rows were journaled into ANOTHER ledger, and whose journal is
 * not live there. This sweep must not rebuild it (it would post another ledger's batch into its own
 * books), and nothing else will: the cron runs one connector's sweep. So it is reported, by name, every
 * run until someone deals with it.
 */
export function foreignLedgerDailyBatchReport(input: {
  type: string
  referenceId: string
  foreignConnector: string
  sweepConnector: string
  rowCount: number
  rowNoun: 'order' | 'shipment'
}): string {
  const rows = `${input.rowCount} ${input.rowNoun}${input.rowCount === 1 ? '' : 's'}`
  return `Daily batch ${input.type} not recreated: ${input.referenceId} — ${rows} in it were journaled into `
    + `${input.foreignConnector}, and no live journal for that batch is on record there. This sweep posts to `
    + `${input.sweepConnector} and will not rebuild another ledger's batch into its own books. If the journal `
    + `really is missing from ${input.foreignConnector}, post it there by hand from the rows it names (o3d-1xmo).`
}

type RevenueDeferralLedgerClient = {
  accountingSyncLog: {
    findMany(args: {
      where: { type: string; referenceId: string }
      select: { connector: true }
    }): Promise<Array<{ connector: string | null }>>
  }
}

/**
 * o3d-2guf — the ledger Group A1 deferred an order's revenue into.
 *
 * The recorded column first. For an order staged before it existed, the batch's own sync log, read by
 * its exact reference: one connector across every row under that reference is an answer; none, or more
 * than one, is not. `null` means UNKNOWN — the caller decides what an unknown ledger may do.
 */
export async function resolveRevenueDeferralLedger(
  client: RevenueDeferralLedgerClient,
  order: { revenueDeferredConnector?: string | null; revenueDeferredBatchRef?: string | null },
): Promise<{ connector: string; source: 'recorded' | 'batch_log' } | null> {
  if (order.revenueDeferredConnector) return { connector: order.revenueDeferredConnector, source: 'recorded' }
  if (!order.revenueDeferredBatchRef) return null
  const rows = await client.accountingSyncLog.findMany({
    where: { type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: order.revenueDeferredBatchRef },
    select: { connector: true },
  })
  const connectors = [...new Set(rows.map((row) => row.connector).filter((value): value is string => !!value))]
  return connectors.length === 1 ? { connector: connectors[0], source: 'batch_log' } : null
}
