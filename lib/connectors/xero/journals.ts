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
  status: string = 'POSTED',
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  // Xero Manual Journal lines use a single signed `LineAmount` field
  // (positive = debit, negative = credit). DebitAmount/CreditAmount are
  // not accepted on ManualJournals — Xero rejects the payload with
  // "The LineAmount field is mandatory". See:
  // https://developer.xero.com/documentation/api/accounting/manualjournals
  const journalLines = entry.lines
    .map((line: JournalLine) => {
      const debit = Number(line.debit ?? 0)
      const credit = Number(line.credit ?? 0)
      const signed = debit - credit
      if (signed === 0) return null // skip zero lines — Xero would reject them
      const xeroLine: Record<string, unknown> = {
        LineAmount: Math.round(signed * 100) / 100,
        AccountCode: line.accountCode,
        Description: line.description,
      }
      if (line.taxType) xeroLine.TaxType = line.taxType
      return xeroLine
    })
    .filter((l): l is Record<string, unknown> => l !== null)

  if (journalLines.length === 0) {
    return { success: false, error: 'Journal has no non-zero lines' }
  }

  // Validate debits = credits (sum of signed LineAmounts must be zero)
  const totalDebits = entry.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)
  const totalCredits = entry.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)
  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    return { success: false, error: `Journal unbalanced: debits=${totalDebits}, credits=${totalCredits}` }
  }

  const journal: Record<string, unknown> = {
    Narration: entry.narration,
    Date: entry.date,
    JournalLines: journalLines,
    Status: status,
  }

  const res = await xeroPost<XeroManualJournalResponse>('ManualJournals', journal)
  if (!res.ok || !res.data?.ManualJournals?.length) {
    return { success: false, error: res.error ?? 'Failed to create manual journal' }
  }

  return { success: true, journalId: res.data.ManualJournals[0].ManualJournalID }
}
