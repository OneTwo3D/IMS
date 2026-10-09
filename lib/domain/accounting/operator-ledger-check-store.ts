/**
 * Reading operator ledger checks (see operator-ledger-check.ts for what one is and the rule that reads
 * it). Kept apart from the rule so the rule stays pure, and apart from the recorder so the money paths
 * that only READ checks do not import the probe and the enqueue machinery the recorder needs.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import type { OperatorLedgerCheck } from './operator-ledger-check'

export type OperatorLedgerCheckReader = Pick<Prisma.TransactionClient, 'accountingOperatorLedgerCheck'>

/** The columns the rule reads. Spread into every select, so no reader can load fewer. */
export const OPERATOR_LEDGER_CHECK_SELECT = {
  id: true,
  syncLogId: true,
  paymentId: true,
  connector: true,
  ledgerDocumentId: true,
  ledgerRecordIds: true,
  tenantId: true,
  connectionGeneration: true,
} as const

/**
 * Every check recorded for any of these attempts AND this receipt on this connector.
 *
 * Narrowed only by the three keys the rule requires to be equal anyway; the document, organisation and
 * generation are left to the rule, so a check that fails them is visibly NOT applied rather than never
 * seen. With no receipt or no attempts there is nothing a check could be about, and the answer is
 * empty without a query.
 */
export async function loadOperatorLedgerChecks(
  client: OperatorLedgerCheckReader,
  scope: { syncLogIds: readonly string[]; paymentId: string | null; connector: string },
): Promise<OperatorLedgerCheck[]> {
  const syncLogIds = [...new Set(scope.syncLogIds.filter((id) => typeof id === 'string' && id !== ''))]
  if (scope.paymentId === null || scope.paymentId === '' || syncLogIds.length === 0) return []
  const rows = await client.accountingOperatorLedgerCheck.findMany({
    where: { syncLogId: { in: syncLogIds }, paymentId: scope.paymentId, connector: scope.connector },
    select: OPERATOR_LEDGER_CHECK_SELECT,
    orderBy: { checkedAt: 'asc' },
  })
  return rows.map((row) => ({ ...row, ledgerRecordIds: [...row.ledgerRecordIds] }))
}
