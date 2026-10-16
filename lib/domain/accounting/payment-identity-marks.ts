/**
 * The marks of the OTHER payments registered against the same order — what the revival gate needs to
 * attribute a deposit's ledger record to the deposit (payment-identity.ts). Kept apart from the pure
 * partition because it reads the database and derives marks, and `followup-retry-guard` (which the
 * partition's callers import) must not be imported by the partition.
 */

import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'
import { effectiveTokenFor } from './followup-retry-guard'
import { settlementMarkerFor } from './ledger-settlement-evidence'
import {
  NO_LIVE_RECEIPTS,
  loadLiveReceipts,
  partitionByPaymentIdentity,
  receiptIdOfPayload,
  type ReceiptReader,
} from './payment-identity'

type RowReader = {
  accountingSyncLog: {
    findMany: (args: {
      where: { connector: string; type: 'INVOICE_PAYMENT'; referenceType: 'SalesOrder'; referenceId: string; remoteAttemptedAt: { not: null }; id: { not: string } }
      select: { id: true; payload: true }
    }) => Promise<Array<{ id: string; payload: unknown }>>
  }
}

/**
 * Marks of every previously-ATTEMPTED INVOICE_PAYMENT row of the order that is PROVEN to be a different
 * payment from `target`. A failed read answers an empty list (nothing attributed: the refusing direction).
 */
export async function marksOfOtherPayments(
  client: RowReader & ReceiptReader,
  params: { connector: AccountingConnectorId; orderId: string; target: { id: string; payload: unknown } },
): Promise<string[]> {
  try {
    const targetPaymentId = receiptIdOfPayload(params.target.payload)
    if (targetPaymentId === null) return []
    const rows = await client.accountingSyncLog.findMany({
      where: {
        connector: params.connector, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: params.orderId,
        remoteAttemptedAt: { not: null }, id: { not: params.target.id },
      },
      select: { id: true, payload: true },
    })
    const liveReceipts = rows.length > 0 ? await loadLiveReceipts(client, params.orderId) : NO_LIVE_RECEIPTS
    const { different } = partitionByPaymentIdentity(
      { paymentId: targetPaymentId, orderId: params.orderId },
      rows.map((row) => ({ ...row, paymentId: receiptIdOfPayload(row.payload) })),
      liveReceipts,
    )
    return different.map((row) => settlementMarkerFor(effectiveTokenFor(params.connector, row)))
  } catch {
    return []
  }
}
