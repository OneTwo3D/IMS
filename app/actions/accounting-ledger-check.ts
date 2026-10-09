'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireFreshPermission, requirePermission } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { probeLedgerSettlement } from '@/lib/connectors/accounting-settlement-probe'
import {
  describeRecordedOperatorLedgerCheck,
  previewOperatorLedgerCheck,
  recordOperatorLedgerCheck,
  type LedgerCheckPreview,
  type LedgerCheckRefusal,
} from '@/lib/domain/accounting/operator-ledger-check-record'
import {
  loadInvoicePaymentSyncRows,
  registerInvoicePaymentWithLedger,
} from '@/lib/domain/accounting/invoice-payment-enqueue'
import { LEDGER_HELD_REGISTRATION_STATUSES } from '@/lib/domain/accounting/payment-ledger-hold'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { toDecimal } from '@/lib/domain/math/decimal'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'

// ---------------------------------------------------------------------------
// o3d-llyw (owner decision C4) — THE OPERATOR LEDGER CHECK, the remedy for a receipt held back because
// the ledger holds settlements IMS cannot read. The rule lives in lib/domain/accounting/
// operator-ledger-check.ts, the recording flow in operator-ledger-check-record.ts; this module is only
// the two authenticated entry points. Types are imported from the lib modules by consumers: a 'use server'
// module may export only async functions (Turbopack registers every export as an action).
// ---------------------------------------------------------------------------

/**
 * Read the ledger for this entry's document and say what a check would have to cover — or why none
 * applies. Read-only (one connector GET); `sync` permission, like every accounting-sync read.
 */
export async function previewLedgerCheck(syncLogId: string): Promise<LedgerCheckRefusal | LedgerCheckPreview> {
  await requirePermission('sync')
  if (typeof syncLogId !== 'string' || syncLogId.trim() === '') {
    return { ok: false, code: 'ROW_MISSING', error: 'No accounting sync entry was named.' }
  }
  return previewOperatorLedgerCheck(syncLogId, { client: db, probe: probeLedgerSettlement })
}

type RecordLedgerCheckResult =
  | LedgerCheckRefusal
  | FreshAuthFailureResult
  | {
      ok: true
      checkId: string
      /** Whether the receipt now has a registration queued, in flight or done — read after re-registering. */
      receiptRegistered: boolean
      message: string
    }

/**
 * Record the check, then re-run the receipt's guarded registration, which reads the check under the
 * rule. A ledger-affecting assertion, so `requireFreshPermission('sync')` exactly as the settlement
 * action: a session re-verified in the last 15 minutes.
 */
export async function recordLedgerCheck(input: {
  syncLogId: string
  paymentId: string
  recordIds: string[]
  /** Echoed from the preview: the connection, document and attempt description the operator confirmed. */
  expectedTenantId: string
  expectedConnectionGeneration: string
  expectedLedgerDocumentId: string
  expectedAttemptLabel: string
  /** Echoed from the preview: each record's fingerprint as shown, keyed by record id. */
  expectedRecordFingerprints: Record<string, string>
  note?: string | null
  /** The operator ticked the statement of what they checked. Required. */
  confirmed: boolean
}): Promise<RecordLedgerCheckResult> {
  try {
    const session = await requireFreshPermission('sync')
    if (input?.confirmed !== true) {
      return {
        ok: false,
        code: 'RECEIPT_INVALID',
        error: 'Confirm that you opened every listed settlement and that none of them is the earlier attempt or this receipt. Nothing was recorded.',
      }
    }
    const recorded = await recordOperatorLedgerCheck({
      syncLogId: String(input.syncLogId ?? ''),
      paymentId: String(input.paymentId ?? ''),
      recordIds: Array.isArray(input.recordIds) ? input.recordIds.map(String) : [],
      expectedTenantId: String(input.expectedTenantId ?? ''),
      expectedConnectionGeneration: String(input.expectedConnectionGeneration ?? ''),
      expectedLedgerDocumentId: String(input.expectedLedgerDocumentId ?? ''),
      expectedAttemptLabel: String(input.expectedAttemptLabel ?? ''),
      expectedRecordFingerprints: input.expectedRecordFingerprints && typeof input.expectedRecordFingerprints === 'object'
        ? Object.fromEntries(Object.entries(input.expectedRecordFingerprints).map(([id, fp]) => [String(id), String(fp)]))
        : {},
      note: typeof input.note === 'string' ? input.note : null,
      userId: session.user.id,
    }, { client: db, probe: probeLedgerSettlement })
    if (!recorded.ok) return recorded

    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: recorded.orderId,
      action: 'operator_ledger_check_recorded',
      tag: 'accounting',
      level: 'WARNING',
      description: describeRecordedOperatorLedgerCheck({
        ...recorded,
        syncLogId: input.syncLogId,
        actor: session.user.name ?? session.user.email ?? session.user.id,
      }),
      metadata: {
        operatorLedgerCheckId: recorded.checkId,
        syncLogId: input.syncLogId,
        paymentId: recorded.paymentId,
        ledgerDocumentId: recorded.ledgerDocumentId,
        ledgerRecordIds: recorded.recordIds,
        tenantId: recorded.binding.tenantId,
        connectionGeneration: recorded.binding.connectionGeneration,
        basis: 'OPERATOR_ASSERTION',
      },
      userId: session.user.id,
    })

    // RE-RUN THE SAME GUARDED REGISTRATION addPayment runs. Nothing else would come back for a refused
    // receipt, and a second, laxer copy of the decision is exactly what this codebase refuses to grow.
    // Idempotent: the enqueue is keyed on (receipt, document), so a receipt already queued stays queued.
    const receipt = await db.payment.findUnique({
      where: { id: recorded.paymentId },
      select: {
        id: true, amount: true, currency: true, method: true, reference: true, paidAt: true,
        order: { select: { id: true, orderNumber: true, externalOrderNumber: true, currency: true } },
      },
    })
    if (receipt) {
      await registerInvoicePaymentWithLedger({
        orderId: receipt.order.id,
        orderReference: getSalesOrderReference(receipt.order),
        paymentId: receipt.id,
        amount: toDecimal(receipt.amount),
        currency: receipt.currency,
        method: receipt.method,
        reference: receipt.reference,
        paidAt: receipt.paidAt,
      })
    }
    const rows = receipt
      ? await loadInvoicePaymentSyncRows(receipt.order.id, recorded.connector, receipt.order.currency)
      : []
    const receiptRegistered = rows.some((row) => row.paymentId === recorded.paymentId
      && (LEDGER_HELD_REGISTRATION_STATUSES as readonly string[]).includes(row.status))
    revalidatePath('/sync')
    return {
      ok: true,
      checkId: recorded.checkId,
      receiptRegistered,
      message: receiptRegistered
        ? 'Check recorded. The receipt is queued for registration; it is checked against the ledger again '
          + 'immediately before it is sent.'
        : 'Check recorded, but the receipt is still not registered — see the order\'s activity log for the reason '
          + 'IMS gave this time.',
    }
  } catch (error) {
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}
