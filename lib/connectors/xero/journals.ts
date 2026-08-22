/**
 * Push manual journals to Xero — COGS, inventory adjustments, stock-in-transit.
 *
 * SPLIT IN TWO, AND THE SPLIT IS THE WHOLE OF o3d-jit6 r2 FINDING 1 (Codex).
 *
 * `pushManualJournal` used to do both halves in one call: it BUILT and VALIDATED the request body —
 * dropping zero lines, refusing a journal with nothing left, refusing an unbalanced one — and only
 * then sent it. Both refusals return WITHOUT CALLING XERO.
 *
 * That is fatal to the caller one layer up. The manual-journal branch of the sync processor mints a
 * durable "a create for this row is on the wire" record in the claim fence, IMMEDIATELY BEFORE this
 * call, because the record has to survive a commit failure that happens after a successful post. If a
 * gate inside this function then refuses, the marker is written and NOTHING LEFT THE PROCESS — and a
 * later, legitimate attempt reads a dispatch that never happened and refuses a create nobody made.
 * That is the same class of error as the duplicate the marker exists to prevent, in the opposite
 * direction (see lib/domain/accounting/create-dispatch-record.ts, which has already had this argument
 * once about the claim fence).
 *
 * So every gate that can refuse now lives in {@link prepareManualJournal}, which is PURE and
 * SYNCHRONOUS and touches nothing outside its arguments, and the caller runs it BEFORE it plans or
 * mints anything. {@link postPreparedManualJournal} is what remains: it takes a body that has already
 * cleared every check and hands it to the transport. It has no refusal of its own left to make, which
 * is the property the processor depends on — see the branch's comment there.
 *
 * `pushManualJournal` stays as the composition of the two, for callers with no dispatch record to
 * protect (the generic `XeroConnector.postJournalEntry` adapter). Its behaviour is unchanged.
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
 * A journal body that has cleared every local check and is ready for the wire.
 *
 * Opaque by construction: the only way to obtain one is {@link prepareManualJournal}, so a call site
 * cannot reach {@link postPreparedManualJournal} with an unvalidated body — it would not compile.
 */
export type PreparedManualJournal = {
  readonly journal: Record<string, unknown>
}

export type ManualJournalPreparation =
  | { ok: true; prepared: PreparedManualJournal }
  | { ok: false; error: string }

/**
 * Build and CHECK the request body. PURE — no clock, no database, no network, nothing ambient.
 *
 * Every reason this module has to refuse a journal is here, so a caller that runs it first knows that
 * what follows either reaches Xero or fails at the transport.
 */
export function prepareManualJournal(
  entry: JournalEntry,
  status: string = 'POSTED',
): ManualJournalPreparation {
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
    return { ok: false, error: 'Journal has no non-zero lines' }
  }

  // Validate debits = credits (sum of signed LineAmounts must be zero)
  const totalDebits = entry.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0)
  const totalCredits = entry.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0)
  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    return { ok: false, error: `Journal unbalanced: debits=${totalDebits}, credits=${totalCredits}` }
  }

  return {
    ok: true,
    prepared: {
      journal: {
        Narration: entry.narration,
        Date: entry.date,
        JournalLines: journalLines,
        Status: status,
      },
    },
  }
}

/**
 * Send a body that has already cleared {@link prepareManualJournal}.
 *
 * MAKES NO CHECKS. Anything added here would be a gate BELOW the caller's dispatch record again, which
 * is the defect this split exists to close — a new rule about journals belongs in `prepareManualJournal`.
 */
export async function postPreparedManualJournal(
  prepared: PreparedManualJournal,
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  const res = await xeroPost<XeroManualJournalResponse>('ManualJournals', prepared.journal, opts)
  if (!res.ok || !res.data?.ManualJournals?.length) {
    return { success: false, error: res.error ?? 'Failed to create manual journal' }
  }

  return { success: true, journalId: res.data.ManualJournals[0].ManualJournalID }
}

/**
 * Create a manual journal entry in Xero.
 *
 * Prepare-then-post, for callers that have nothing recorded ahead of the call. A caller that mints a
 * dispatch record must NOT use this — it has to run the two halves itself, with the mint between them.
 */
export async function pushManualJournal(
  entry: JournalEntry,
  status: string = 'POSTED',
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  const preparation = prepareManualJournal(entry, status)
  if (!preparation.ok) return { success: false, error: preparation.error }
  return postPreparedManualJournal(preparation.prepared, opts)
}
