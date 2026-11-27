import { db } from '@/lib/db'
import { toDecimal } from '@/lib/domain/math/decimal'
import { journalNetMovement } from './journal-account-nets'

/**
 * An INDEPENDENT check of a movement sub-ledger (cogs_subledger_movements / transit_subledger_movements).
 *
 * The GL reconciliations compare the sub-ledger with Xero. But every sub-ledger row is written by the same code, from the same local
 * variables, as the journal payload it mirrors, so a reconciliation that agrees proves the journal arrived and the row was written
 * with the same figure, not that either figure is right, and a posting site that forgets the row (the manufacturing reclass did)
 * leaves a gap that reads as a GL fault. This reads the OTHER side: the journals as they were actually queued (their own persisted lines,
 * or the per-account summary compaction keeps), summed for the account over the same GL-date window, and compares that with what the
 * sub-ledger recorded. A difference names the sub-ledger or a posting site, not the ledger.
 *
 * Scope is exactly the journal-shaped flows named by the caller. Bill-shaped transit flows (a purchase bill, a supplier credit note)
 * are not journals and have no `lines`, so they are outside it; a caller names only the flows it can pair on both sides.
 */
export type SubledgerCrossCheckInput = {
  accountCode: string
  /** `(openingExclusive, closingInclusive]` as YYYY-MM-DD, the GL window of the reconciliation. */
  openingExclusive: string
  closingInclusive: string
  /** Sync-log types whose journals carry the account's flow. */
  logTypes: readonly string[]
  /** Sync-log reference types to leave out (a flow of the same type recorded under another sub-ledger source). */
  excludeReferenceTypes?: readonly string[]
  /** The sub-ledger's own source types for those same flows. */
  ledgerSourceTypes: readonly string[]
}

export type SubledgerCrossCheck = {
  ledgerNet: number
  queuedNet: number
  /** ledger − queued. */
  delta: number
  tolerance: number
  journalCount: number
  ledgerRowCount: number
  /** Journals in the window whose lines could not be read (compacted with no summary, an empty `{}` payload, or no readable lines): they are not in `queuedNet`. */
  unreadableJournalCount: number
  /** Of those, the journals compaction emptied (payload `{}`): they carry no date, so they cannot be placed in the window at all. */
  compactedJournalCount: number
  /** FAILED or CANCELLED journals in the window that move the account. They are NOT queued movement, but the sub-ledger rows written when they were queued remain, so their net is expected on the ledger side. */
  notLiveJournalCount: number
  notLiveNet: number
  /** Journals left out because they predate the sub-ledger row that mirrors them (MANUFACTURING_RECLASS queued before that row existed). */
  preCutInJournalCount: number
  /** Readable journals of these flows in the window that touch other accounts but not the configured one: the account was probably re-bound, so the figure cannot be trusted. */
  otherAccountJournalCount: number
  /** True when the comparison cannot be made soundly (a probable chart re-bind): `agrees` is then true and no mismatch is raised, the reason is reported instead. */
  inconclusive: boolean
  agrees: boolean
}

const LIVE_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED'] as const
// A journal that never reached the ledger. Its sub-ledger row (written in the queueing transaction) is still there.
const NOT_LIVE_STATUSES = ['FAILED', 'CANCELLED'] as const
// A journal can be dated before the day it was queued (a backdated posting) but not by more than this.
const QUEUED_LOOKBACK_MS = 35 * 86_400_000

type LedgerClient = {
  aggregate(args: unknown): Promise<{ _sum: { baseDelta: unknown }; _count?: unknown }>
  count(args: unknown): Promise<number>
}

export function evaluateSubledgerCrossCheck(input: {
  ledgerNet: number
  queuedNet: number
  journalCount: number
  ledgerRowCount: number
  unreadableJournalCount: number
  compactedJournalCount?: number
  notLiveJournalCount?: number
  notLiveNet?: number
  preCutInJournalCount?: number
  otherAccountJournalCount?: number
}): SubledgerCrossCheck {
  const compactedJournalCount = input.compactedJournalCount ?? 0
  const notLiveJournalCount = input.notLiveJournalCount ?? 0
  const notLiveNet = input.notLiveNet ?? 0
  const preCutInJournalCount = input.preCutInJournalCount ?? 0
  const otherAccountJournalCount = input.otherAccountJournalCount ?? 0
  // The sub-ledger holds a row for every journal that was queued, whether or not it later posted, so the ledger side is compared with
  // the live journals PLUS the not-live ones that are reported beside them.
  const delta = Math.round((input.ledgerNet - (input.queuedNet + notLiveNet)) * 1_000_000) / 1_000_000
  // Each journal is posted at 2dp and each row recorded at up to 6dp, so half a penny per posting is the rounding the two can differ by.
  const tolerance = Math.round((0.005 * (input.journalCount + notLiveJournalCount + input.ledgerRowCount) + 0.01) * 100) / 100
  const inconclusive = otherAccountJournalCount > 0
  return {
    ...input,
    compactedJournalCount,
    notLiveJournalCount,
    notLiveNet,
    preCutInJournalCount,
    otherAccountJournalCount,
    delta,
    tolerance,
    inconclusive,
    agrees: inconclusive || (Math.abs(delta) <= tolerance && input.unreadableJournalCount === 0),
  }
}

export async function crossCheckSubledgerAgainstQueuedJournals(
  input: SubledgerCrossCheckInput,
  ledger: 'cogs' | 'transit',
): Promise<SubledgerCrossCheck> {
  const opening = new Date(`${input.openingExclusive}T00:00:00.000Z`)
  const closing = new Date(`${input.closingInclusive}T00:00:00.000Z`)
  // The MANUFACTURING_RECLASS sub-ledger row exists only from the change that began writing it; a reclass journal queued before that has
  // no row and is not a gap. Its cut-in is the first such row (none yet: no reclass journal can be compared).
  const reclassCutIn = ledger === 'cogs' && input.logTypes.includes('MANUFACTURING_RECLASS')
    ? (await db.cogsSubledgerMovement.findFirst({ where: { sourceType: 'MANUFACTURING_RECLASS' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null
    : null
  const logs = await db.accountingSyncLog.findMany({
    where: {
      type: { in: input.logTypes as never },
      status: { in: [...LIVE_STATUSES, ...NOT_LIVE_STATUSES] },
      createdAt: { gte: new Date(opening.getTime() - QUEUED_LOOKBACK_MS) },
      ...(input.excludeReferenceTypes?.length ? { referenceType: { notIn: [...input.excludeReferenceTypes] } } : {}),
    },
    select: { type: true, status: true, createdAt: true, payload: true, payloadAccountNets: true },
  })
  let queuedNet = 0
  let journalCount = 0
  let unreadableJournalCount = 0
  let compactedJournalCount = 0
  let notLiveJournalCount = 0
  let notLiveNet = 0
  let preCutInJournalCount = 0
  let otherAccountJournalCount = 0
  for (const log of logs) {
    const live = (LIVE_STATUSES as readonly string[]).includes(log.status)
    if (log.type === 'MANUFACTURING_RECLASS' && (!reclassCutIn || log.createdAt < reclassCutIn)) { preCutInJournalCount += 1; continue }
    const date = (log.payload as { date?: unknown } | null)?.date
    // A compacted row has no dated payload (null, or `{}`): it cannot be placed in the window, so it is counted as unreadable and
    // says so, never dropped. A readable payload with no date is the same.
    if (typeof date !== 'string') {
      if (live) {
        unreadableJournalCount += 1
        if (log.payload == null || (typeof log.payload === 'object' && Object.keys(log.payload as object).length === 0)) compactedJournalCount += 1
      }
      continue
    }
    if (!(date > input.openingExclusive && date <= input.closingInclusive)) continue
    const net = journalNetMovement(log, input.accountCode, 'debit')
    if (net === null) { if (live) unreadableJournalCount += 1; continue }
    if (net === 0) {
      // Lines that name accounts but never the configured one: the account was re-bound since the journal was queued.
      const lines = (log.payload as { lines?: Array<{ accountCode?: string }> } | null)?.lines
      if (live && Array.isArray(lines) && lines.length > 0 && !lines.some((line) => line.accountCode === input.accountCode)) otherAccountJournalCount += 1
      continue
    }
    if (live) {
      queuedNet += net
      journalCount += 1
    } else {
      notLiveNet += net
      notLiveJournalCount += 1
    }
  }

  const where = { journalDate: { gt: opening, lte: closing }, sourceType: { in: [...input.ledgerSourceTypes] } }
  const client = (ledger === 'cogs' ? db.cogsSubledgerMovement : db.transitSubledgerMovement) as unknown as LedgerClient
  const [sum, ledgerRowCount] = await Promise.all([
    client.aggregate({ _sum: { baseDelta: true }, where }),
    client.count({ where }),
  ])
  return evaluateSubledgerCrossCheck({
    ledgerNet: toDecimal((sum._sum.baseDelta as never) ?? 0).toNumber(),
    queuedNet,
    journalCount,
    ledgerRowCount,
    unreadableJournalCount,
    compactedJournalCount,
    notLiveJournalCount,
    notLiveNet,
    preCutInJournalCount,
    otherAccountJournalCount,
  })
}

/** The COGS account's journal-shaped flows. Dispatch rides the Group B batch journal, refunds and revaluations COGS_REVERSAL, landed-cost COGS_JOURNAL. */
export const COGS_CROSS_CHECK_FLOWS = {
  logTypes: ['DAILY_BATCH_GROUP_B', 'COGS_REVERSAL', 'COGS_JOURNAL', 'MANUFACTURING_RECLASS'],
  ledgerSourceTypes: ['DISPATCH', 'REFUND_REVERSAL', 'SHIPMENT_REVALUATION', 'LANDED_COST_ADJUSTMENT', 'MANUFACTURING_RECLASS'],
} as const

/** The transit flows that are journals on both sides: the stock receipt (not a customer-return arrival), the GR/IR reclass and the per-event purchase FX variance journal. */
export const TRANSIT_CROSS_CHECK_FLOWS = {
  logTypes: ['STOCK_RECEIPT', 'DAILY_BATCH_GRIR_RECLASS', 'PURCHASE_FX_VARIANCE'],
  excludeReferenceTypes: ['ReturnExpectation'],
  ledgerSourceTypes: ['STOCK_RECEIPT', 'GRIR_RECLASS', 'PURCHASE_FX_VARIANCE'],
} as const
