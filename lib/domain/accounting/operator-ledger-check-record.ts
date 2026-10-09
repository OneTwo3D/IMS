/**
 * Recording an operator ledger check (operator-ledger-check.ts has the rule and the reasons).
 *
 * Two steps, and the second re-does the first rather than trusting it:
 *
 *   PREVIEW  — read the ledger for the attempt's document and show the operator EXACTLY which records
 *              IMS cannot measure, what the attempt sent, and which receipts a check could be for.
 *   RECORD   — read the ledger AGAIN, and insert a check only if the records the operator says they
 *              looked at are exactly the unmeasurable records the ledger shows NOW, under the connection
 *              that served THIS read. A record that appeared after the preview, or a reconnect in
 *              between, refuses the check instead of stretching it over something nobody looked at.
 *
 * A check is only ever recorded against an attempt the registration decision itself treats as
 * unresolved (`unresolvedInvoicePaymentAttempts`) and judged with the decision's own attempt description
 * (`describeUnresolvedAttempt`), so a check cannot be recorded for a hold the decision never reaches —
 * and in particular never for a SYNCED row, whose unmeasurable record is that row's own payment.
 *
 * Network I/O (the probe) and database I/O are injected so the whole flow is testable without Xero.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { isRegisteredAccountingConnector, type AccountingConnectorId } from '@/lib/connectors/accounting-registry'
import type { SettlementProbeTarget } from '@/lib/connectors/accounting-settlement-probe'
import {
  formatLedgerMoney,
  isUnmeasurableSettlementRecord,
  type LedgerSettlementProbe,
  type ProbeConnectionBinding,
} from './ledger-settlement-evidence'
import {
  describeUnresolvedAttempt,
  postedRegistrationsOnDocument,
  unresolvedInvoicePaymentAttempts,
} from './invoice-payment-registration'
import { loadInvoicePaymentSyncRows } from './invoice-payment-enqueue'
import {
  classifyLedgerSettlementWithOperatorChecks,
  describeAttemptForLedgerCheck,
  describeLedgerCheckBlockedByPostedRegistration,
  describeLedgerCheckRemedy,
  normaliseLedgerId,
} from './operator-ledger-check'
import { OPERATOR_ASSERTION_SETTLEMENT_BASIS } from './sync-row-settlement'
import { claimsToHavePosted } from './ledger-standing'

export type OperatorLedgerCheckClient = Pick<
  Prisma.TransactionClient,
  'accountingSyncLog' | 'salesOrder' | 'payment' | 'accountingOperatorLedgerCheck'
>

export type OperatorLedgerCheckDeps = {
  client: OperatorLedgerCheckClient
  probe: (connector: AccountingConnectorId, target: SettlementProbeTarget) => Promise<LedgerSettlementProbe>
}

export type LedgerCheckRefusalCode =
  | 'ROW_MISSING'
  | 'NOT_A_RECEIPT_ATTEMPT'
  | 'NOT_UNRESOLVED'
  | 'DOCUMENT_NOT_POSTED'
  | 'NOT_LIFTABLE'
  | 'RECEIPT_INVALID'
  | 'LEDGER_CHANGED'

export type LedgerCheckRefusal = { ok: false; code: LedgerCheckRefusalCode; error: string }

export type LedgerCheckPreview = {
  ok: true
  syncLogId: string
  orderId: string
  connector: AccountingConnectorId
  ledgerDocumentId: string
  /** What the operator compares each record with. */
  attemptLabel: string
  /** The unmeasurable records, as the ledger reported them, in its order. */
  records: Array<{ id: string; date: string | null; unreadableAmount: string | null; reference: string | null }>
  binding: ProbeConnectionBinding
  /** The receipts on the order a check could be recorded for (receipts, not refund payments). */
  receipts: Array<{ id: string; amount: string; currency: string; paidAt: string; method: string | null }>
}

/** Read and judge the attempt; the shared first half of preview and record. */
async function assessAttempt(
  syncLogId: string,
  deps: OperatorLedgerCheckDeps,
): Promise<LedgerCheckRefusal | Omit<LedgerCheckPreview, 'receipts'>> {
  const row = await deps.client.accountingSyncLog.findUnique({
    where: { id: syncLogId },
    select: { id: true, connector: true, type: true, referenceType: true, referenceId: true },
  })
  if (!row) {
    return { ok: false, code: 'ROW_MISSING', error: `Accounting sync entry ${syncLogId} no longer exists. Reload the sync log.` }
  }
  if (row.type !== 'INVOICE_PAYMENT' || row.referenceType !== 'SalesOrder' || !isRegisteredAccountingConnector(row.connector)) {
    return {
      ok: false,
      code: 'NOT_A_RECEIPT_ATTEMPT',
      error: 'An operator ledger check applies only to a customer receipt (INVOICE PAYMENT) entry for a sales order '
        + 'on a connector this build ships. Nothing was recorded.',
    }
  }
  const connector = row.connector
  const order = await deps.client.salesOrder.findUnique({
    where: { id: row.referenceId },
    select: { id: true, accountingInvoiceId: true, currency: true },
  })
  if (!order || !order.accountingInvoiceId) {
    return {
      ok: false,
      code: 'DOCUMENT_NOT_POSTED',
      error: 'The sales order this entry belongs to has no posted invoice, so there is no ledger document to check. '
        + 'Nothing was recorded.',
    }
  }
  // THE DECISION'S OWN READING of which rows are unresolved — the same loader and the same filter — so
  // a check can only be recorded for an attempt that actually holds a receipt back.
  const rows = await loadInvoicePaymentSyncRows(order.id, connector, order.currency, deps.client)
  const attempt = rows.find((candidate) => candidate.id === row.id)
  // ...and never one that CLAIMS TO HAVE POSTED (a swept or retired row that still records a ledger id):
  // its own payment is in the ledger by its own account, so "this record is not its payment" is not a
  // check anyone can make. The loader drops checks for such rows at every gate as well.
  if (!attempt || unresolvedInvoicePaymentAttempts([attempt], '').length === 0 || claimsToHavePosted(attempt)) {
    return {
      ok: false,
      code: 'NOT_UNRESOLVED',
      error: 'This entry is not an unresolved attempt (it is queued, in flight or recorded as done, or its own '
        + 'record proves it never reached the ledger), so it is not what holds a receipt back and there is nothing '
        + 'for a ledger check to lift. Nothing was recorded.',
    }
  }
  const probe = await deps.probe(connector, { type: 'INVOICE_PAYMENT', payload: { accountingInvoiceId: order.accountingInvoiceId } })
  const description = describeUnresolvedAttempt(attempt, order.currency)
  const attemptLabel = describeAttemptForLedgerCheck({
    syncLogId: row.id,
    status: attempt.status,
    amount: description.amount === null ? null : formatLedgerMoney(description.amount),
    currency: description.currency,
    date: description.date,
    marker: description.marker,
  })
  // Judged with NO checks and a placeholder receipt: this step asks only whether the hold is one a
  // check can lift, and which records it would have to name. The receipt is bound at RECORD time.
  const judged = classifyLedgerSettlementWithOperatorChecks(
    description,
    probe,
    {
      attemptSyncLogId: row.id,
      paymentId: '(receipt)',
      connector,
      ledgerDocumentId: order.accountingInvoiceId,
      attemptRecordedLedgerId: attempt.externalTransactionId,
    },
    [],
  )
  const verdict = judged.verdict
  if (!judged.remedy || !probe.ok) {
    const why = verdict.outcome === 'clear'
      ? 'the ledger does not hold this attempt as far as IMS can read it, so it holds nothing back'
      : verdict.outcome === 'present'
        ? `the ledger holds ${verdict.detail}, which matches this attempt — a ledger check never overrides a payment IMS can match`
        : `${verdict.reason} — a ledger check answers only settlements IMS cannot read, not this`
    return { ok: false, code: 'NOT_LIFTABLE', error: `No ledger check applies here: ${why}. Nothing was recorded.` }
  }
  if (!judged.remedy.liftable) {
    return { ok: false, code: 'NOT_LIFTABLE', error: `${describeLedgerCheckRemedy(judged.remedy, attemptLabel)} Nothing was recorded.` }
  }
  // The registration decision would not grant a lift here anyway (see `postedRegistrationsOnDocument`):
  // a registration on this invoice has posted, and the post fence refuses a payment beside it. Asked of
  // EVERY posted row (no receipt is chosen yet), which can only refuse more, never less.
  const posted = postedRegistrationsOnDocument(rows, '', order.accountingInvoiceId)
  if (posted.length > 0) {
    return {
      ok: false,
      code: 'NOT_LIFTABLE',
      error: `${describeLedgerCheckBlockedByPostedRegistration(posted.map((r) => r.id ?? '(unidentified entry)'))} Nothing was recorded.`,
    }
  }
  const records = probe.records
    .filter(isUnmeasurableSettlementRecord)
    .map((record) => ({
      id: (record.id as string).trim(),
      date: record.date,
      unreadableAmount: record.unreadableAmount ?? null,
      reference: record.reference ?? null,
    }))
  return {
    ok: true,
    syncLogId: row.id,
    orderId: order.id,
    connector,
    ledgerDocumentId: order.accountingInvoiceId,
    attemptLabel,
    records,
    binding: judged.remedy.binding,
  }
}

/** PREVIEW: what a check for this entry would have to cover, read from the ledger now. */
export async function previewOperatorLedgerCheck(
  syncLogId: string,
  deps: OperatorLedgerCheckDeps,
): Promise<LedgerCheckRefusal | LedgerCheckPreview> {
  const assessed = await assessAttempt(syncLogId, deps)
  if (!assessed.ok) return assessed
  const receipts = await deps.client.payment.findMany({
    where: { orderId: assessed.orderId, refundId: null },
    select: { id: true, amount: true, currency: true, paidAt: true, method: true },
    orderBy: { paidAt: 'asc' },
  })
  return {
    ...assessed,
    receipts: receipts
      .filter((receipt) => receipt.amount.gt(0))
      .map((receipt) => ({
        id: receipt.id,
        amount: receipt.amount.toFixed(),
        currency: receipt.currency,
        paidAt: receipt.paidAt.toISOString().slice(0, 10),
        method: receipt.method,
      })),
  }
}

export type RecordOperatorLedgerCheckInput = {
  syncLogId: string
  paymentId: string
  /** The record ids the operator was shown and says they opened. Must equal the ledger's set NOW. */
  recordIds: readonly string[]
  /**
   * EVERYTHING ELSE THE OPERATOR WAS SHOWN AND CONFIRMED, echoed back from the preview: the Xero
   * organisation and connection generation that served it, the document, and the attempt description
   * they compared against. Each must equal the fresh read, or nothing is recorded — a check is bound to
   * the connection the operator looked under, never to whichever one is bound when they press the button
   * (identical record ids after a reconnect are not the same records looked at under the same consent).
   */
  expectedTenantId: string
  expectedConnectionGeneration: string
  expectedLedgerDocumentId: string
  expectedAttemptLabel: string
  note?: string | null
  userId: string
}

export type RecordedOperatorLedgerCheck = {
  ok: true
  checkId: string
  orderId: string
  paymentId: string
  connector: AccountingConnectorId
  ledgerDocumentId: string
  recordIds: string[]
  binding: ProbeConnectionBinding
}

const NOTE_LIMIT = 500

/**
 * RECORD: re-read the ledger, refuse unless the operator's records are exactly what it shows now, and
 * insert ONE insert-only check row bound to that read's connection. Does not register anything; the
 * caller re-runs the guarded registration, which reads the check under the rule.
 */
export async function recordOperatorLedgerCheck(
  input: RecordOperatorLedgerCheckInput,
  deps: OperatorLedgerCheckDeps,
): Promise<LedgerCheckRefusal | RecordedOperatorLedgerCheck> {
  if (typeof input.paymentId !== 'string' || input.paymentId.trim() === '' || !Array.isArray(input.recordIds)) {
    return { ok: false, code: 'RECEIPT_INVALID', error: 'Choose the receipt this check is for. Nothing was recorded.' }
  }
  const assessed = await assessAttempt(input.syncLogId, deps)
  if (!assessed.ok) return assessed
  const receipt = await deps.client.payment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, orderId: true, refundId: true, amount: true },
  })
  if (!receipt || receipt.orderId !== assessed.orderId || receipt.refundId !== null || !receipt.amount.gt(0)) {
    return {
      ok: false,
      code: 'RECEIPT_INVALID',
      error: 'That receipt is not a customer receipt on this entry\'s sales order. Nothing was recorded.',
    }
  }
  // EXACTLY the set the ledger shows now — not a subset (a check of some records lifts nothing and
  // invites a second check made without looking), not a superset (naming a record the ledger does not
  // show is a check of nothing). A difference means the ledger moved since the page was rendered.
  const shown = new Set(assessed.records.map((record) => normaliseLedgerId(record.id) as string))
  const claimed = new Set(input.recordIds.map((id) => normaliseLedgerId(typeof id === 'string' ? id : null)))
  const same = claimed.size === shown.size && [...claimed].every((id) => id !== null && shown.has(id))
  if (!same) {
    return {
      ok: false,
      code: 'LEDGER_CHANGED',
      error: `The ledger now shows ${assessed.records.length === 1 ? 'a different unreadable settlement' : 'a different set of unreadable settlements'} `
        + `for this document (${assessed.records.map((record) => record.id).join(', ')}) from the ones this check names. `
        + 'Nothing was recorded. Reopen the check and look at every settlement it now lists; it can be submitted again once you have.',
    }
  }
  // ...and the connection, document and attempt the operator confirmed are the ones read now. Any
  // difference — a Xero reconnect between preview and submit above all — refuses with nothing inserted.
  const shownMatches = typeof input.expectedTenantId === 'string' && input.expectedTenantId === assessed.binding.tenantId
    && typeof input.expectedConnectionGeneration === 'string' && input.expectedConnectionGeneration === assessed.binding.connectionGeneration
    && typeof input.expectedLedgerDocumentId === 'string' && input.expectedLedgerDocumentId === assessed.ledgerDocumentId
    && typeof input.expectedAttemptLabel === 'string' && input.expectedAttemptLabel === assessed.attemptLabel
  if (!shownMatches) {
    return {
      ok: false,
      code: 'LEDGER_CHANGED',
      error: 'What this check was confirmed against has changed since the dialog was opened (the Xero connection, the '
        + 'document or the earlier attempt it describes). Nothing was recorded. Reopen the check and look at every '
        + 'settlement it now lists; it can be submitted again once you have.',
    }
  }
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim().slice(0, NOTE_LIMIT) : null
  const recordIds = assessed.records.map((record) => record.id)
  const created = await deps.client.accountingOperatorLedgerCheck.create({
    data: {
      syncLogId: assessed.syncLogId,
      paymentId: receipt.id,
      connector: assessed.connector,
      ledgerDocumentId: assessed.ledgerDocumentId,
      ledgerRecordIds: recordIds,
      tenantId: assessed.binding.tenantId,
      connectionGeneration: assessed.binding.connectionGeneration,
      basis: OPERATOR_ASSERTION_SETTLEMENT_BASIS,
      checkedByUserId: input.userId,
      note,
    },
    select: { id: true },
  })
  return {
    ok: true,
    checkId: created.id,
    orderId: assessed.orderId,
    paymentId: receipt.id,
    connector: assessed.connector,
    ledgerDocumentId: assessed.ledgerDocumentId,
    recordIds,
    binding: assessed.binding,
  }
}

/** The activity-log sentence for a recorded check. An assertion, attributed; no claim about the ledger. */
export function describeRecordedOperatorLedgerCheck(recorded: RecordedOperatorLedgerCheck & { syncLogId: string; actor: string }): string {
  return `${recorded.actor} recorded operator ledger check ${recorded.checkId}: they assert that ledger `
    + `settlement${recorded.recordIds.length === 1 ? '' : 's'} ${recorded.recordIds.join(', ')} on document `
    + `${recorded.ledgerDocumentId} (Xero organisation ${recorded.binding.tenantId}, connection `
    + `${recorded.binding.connectionGeneration}) ${recorded.recordIds.length === 1 ? 'is' : 'are'} not the payment `
    + `entry ${recorded.syncLogId} made and not a hand-entered payment for receipt ${recorded.paymentId}. IMS did not `
    + 'verify this. It applies only to those settlement ids and only until Xero is reconnected.'
}
