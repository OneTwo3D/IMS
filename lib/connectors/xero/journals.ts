/**
 * Push manual journals to Xero — COGS, inventory adjustments, stock-in-transit.
 */

import { xeroPost } from './api'
import type { JournalEntry, JournalLine } from '../types'

type XeroManualJournalResponse = {
  ManualJournals: Array<{
    ManualJournalID: string
    Narration: string
    Status: string
  }>
}

/**
 * Create a manual journal entry in Xero.
 */
export async function pushManualJournal(
  entry: JournalEntry,
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  const journalLines = entry.lines.map((line: JournalLine) => {
    const xeroLine: Record<string, unknown> = {
      AccountCode: line.accountCode,
      Description: line.description,
    }
    if (line.debit && line.debit > 0) xeroLine.DebitAmount = line.debit
    if (line.credit && line.credit > 0) xeroLine.CreditAmount = line.credit
    if (line.taxType) xeroLine.TaxType = line.taxType
    return xeroLine
  })

  // Validate debits = credits
  const totalDebits = entry.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const totalCredits = entry.lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    return { success: false, error: `Journal unbalanced: debits=${totalDebits}, credits=${totalCredits}` }
  }

  const journal: Record<string, unknown> = {
    Narration: entry.narration,
    Date: entry.date,
    JournalLines: journalLines,
    Status: 'POSTED',
  }

  const res = await xeroPost<XeroManualJournalResponse>('ManualJournals', journal)
  if (!res.ok || !res.data?.ManualJournals?.length) {
    return { success: false, error: res.error ?? 'Failed to create manual journal' }
  }

  return { success: true, journalId: res.data.ManualJournals[0].ManualJournalID }
}
