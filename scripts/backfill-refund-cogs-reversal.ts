#!/usr/bin/env tsx
//
// khdw: backfill SalesOrderRefund.cogsReversalBase + cogsReversalJournalDate from
// the synced COGS_REVERSAL accounting sync logs, for refunds staged before those
// structured columns existed. Idempotent: only touches rows where cogsReversalBase
// is still null. Chargebacks (no COGS reversal staged) have no COGS_REVERSAL log
// and are naturally skipped.
//
// The COGS reconciliation is forward-looking (per-batch period movement) and
// flag-vs-sweep safe, so an un-backfilled historical row can never mis-sweep — at
// worst its window flags. This backfill completes the data so refund-day windows
// reconcile cleanly rather than flagging.
//
// Usage: tsx scripts/backfill-refund-cogs-reversal.ts [--dry-run] [--limit N]

import { db } from '../lib/db/index'

function readNumberArg(name: string): number | null {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  const raw = inline ? inline.slice(prefix.length) : null
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

const DRY_RUN = process.argv.includes('--dry-run')

/** Extract the COGS reversal amount (the credit line) and posting date from a
 *  COGS_REVERSAL journal payload. Returns null when the shape is unrecognised. */
function parseCogsReversalPayload(payload: unknown): { base: number; journalDate: Date } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  const dateStr = typeof record.date === 'string' ? record.date : null
  const lines = Array.isArray(record.lines) ? record.lines : null
  if (!dateStr || !lines) return null
  // The COGS_REVERSAL journal credits the COGS account; that credit is the reversal
  // amount (the matching debit hits inventory). Sum credit lines defensively.
  let credit = 0
  for (const line of lines) {
    if (typeof line === 'object' && line !== null) {
      const value = (line as Record<string, unknown>).credit
      if (typeof value === 'number' && Number.isFinite(value)) credit += value
    }
  }
  if (credit <= 0) return null
  const journalDate = new Date(`${dateStr}T00:00:00.000Z`)
  if (Number.isNaN(journalDate.getTime())) return null
  return { base: credit, journalDate }
}

async function main(): Promise<void> {
  const limit = readNumberArg('limit') ?? undefined

  const candidates = await db.salesOrderRefund.findMany({
    where: { cogsReversalBase: null, chargeback: false },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  console.log(`${candidates.length} refund(s) with no structured COGS reversal to inspect${DRY_RUN ? ' (dry run)' : ''}.`)

  let updated = 0
  let skipped = 0
  for (const refund of candidates) {
    const log = await db.accountingSyncLog.findFirst({
      where: { type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refund.id },
      orderBy: { createdAt: 'asc' },
      select: { payload: true },
    })
    const parsed = log ? parseCogsReversalPayload(log.payload) : null
    if (!parsed) {
      skipped++
      continue
    }
    if (!DRY_RUN) {
      await db.salesOrderRefund.update({
        where: { id: refund.id },
        data: { cogsReversalBase: parsed.base, cogsReversalJournalDate: parsed.journalDate },
      })
    }
    updated++
  }

  console.log(`${DRY_RUN ? 'Would update' : 'Updated'} ${updated} refund(s); ${skipped} skipped (no parseable COGS_REVERSAL log).`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
