/**
 * QuickBooks Online journal entry creation.
 *
 * Key difference from Xero: QBO JournalEntry uses PostingType "Debit"/"Credit"
 * with positive Amount values, whereas Xero uses a single signed LineAmount.
 */

import type { JournalEntry } from '@/lib/connectors/types'
import { qboPost, qboPostIdempotent, resolveAccountRef } from './api'

type QboJournalEntry = {
  Id: string
  DocNumber?: string
}

/**
 * Create a manual journal entry in QuickBooks.
 * Validates that total debits equal total credits before posting.
 */
export async function pushJournalEntry(
  entry: JournalEntry,
  status?: string,
  opts?: { requestId?: string },
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  try {
    void status
    // Filter out zero-amount lines
    const activeLines = entry.lines.filter((line) => {
      const debit = Number(line.debit ?? 0)
      const credit = Number(line.credit ?? 0)
      return Math.abs(debit - credit) >= 0.005
    })

    if (activeLines.length === 0) {
      return { success: false, error: 'Journal entry has no non-zero lines' }
    }

    // Validate debits = credits
    let totalDebit = 0
    let totalCredit = 0
    for (const line of activeLines) {
      totalDebit += Number(line.debit ?? 0)
      totalCredit += Number(line.credit ?? 0)
    }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return {
        success: false,
        error: `Journal out of balance: debits=${totalDebit.toFixed(2)}, credits=${totalCredit.toFixed(2)}`,
      }
    }

    // Build QBO journal lines
    const qboLines: Array<Record<string, unknown>> = []
    for (const line of activeLines) {
      const debit = Number(line.debit ?? 0)
      const credit = Number(line.credit ?? 0)
      const isDebit = debit > credit

      const accountRef = await resolveAccountRef(line.accountCode)
      if (!accountRef) {
        return { success: false, error: `Account not found in QuickBooks: ${line.accountCode}` }
      }

      const detail: Record<string, unknown> = {
        PostingType: isDebit ? 'Debit' : 'Credit',
        AccountRef: accountRef,
      }
      if (line.taxType) {
        detail.TaxCodeRef = { value: line.taxType }
      }

      qboLines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: Math.round(Math.abs(debit - credit) * 100) / 100,
        Description: line.description,
        JournalEntryLineDetail: detail,
      })
    }

    const body: Record<string, unknown> = {
      TxnDate: entry.date,
      Line: qboLines,
    }

    if (entry.reference) body.DocNumber = entry.reference
    if (entry.narration) body.PrivateNote = entry.narration

    const res = opts?.requestId
      ? await qboPostIdempotent<{ JournalEntry: QboJournalEntry }>('journalentry', body, opts.requestId)
      : await qboPost<{ JournalEntry: QboJournalEntry }>('journalentry', body)
    if (!res.ok || !res.data) {
      return { success: false, error: res.error ?? 'Failed to create journal entry' }
    }

    return { success: true, journalId: res.data.JournalEntry.Id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
