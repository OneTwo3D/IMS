import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'
import { isFxGainLossJournalSuppressed } from '@/lib/accounting'

// o3d-lgo.6.1: Xero posts realised/unrealised FX gain/loss natively and rejects
// manual-journal lines to its system AR/AP control accounts, so IMS suppresses
// its own FX journals for Xero only.
//
// o3d-remove-parked-connectors — WHY THE NEGATIVE CASE USES AN UNREGISTERED ID.
//
// The negative case used to name QuickBooks, the second REGISTERED connector, and it is the only
// thing in this file that shows the predicate consults the connector AT ALL: without it,
// `isFxGainLossJournalSuppressed` could be reduced to `FX_GAIN_LOSS_JOURNAL_TYPES.has(type)` and
// every remaining assertion would still pass. That is not a hypothetical — the suppression settles an
// FX obligation, so applying Xero's rule to a ledger that DOES accept an AP/AR manual journal would
// silence pounds that ledger never posted.
//
// QuickBooks is archived, so the only subject left is an id the union does not contain. The cast is
// the point, not a workaround: what is locked is that the predicate is keyed by connector. It is a
// weaker subject than a second shipped connector, and docs/archive/quickbooks-connector-removal.md
// records it as such.
const UNREGISTERED_CONNECTOR = 'another-ledger' as unknown as AccountingConnectorId

test('FX gain/loss journals are suppressed for Xero (both realised and unrealised)', () => {
  assert.equal(isFxGainLossJournalSuppressed('xero', 'REALISED_FX_JOURNAL'), true)
  assert.equal(isFxGainLossJournalSuppressed('xero', 'UNREALISED_FX_JOURNAL'), true)
})

test('the suppression is KEYED BY CONNECTOR — another ledger keeps its FX journals', () => {
  assert.equal(isFxGainLossJournalSuppressed(UNREGISTERED_CONNECTOR, 'REALISED_FX_JOURNAL'), false)
  assert.equal(isFxGainLossJournalSuppressed(UNREGISTERED_CONNECTOR, 'UNREALISED_FX_JOURNAL'), false)
})

test('non-FX sync types are never suppressed (Xero keeps every other journal)', () => {
  for (const type of [
    'SALES_INVOICE',
    'BILL_PAYMENT',
    'INVOICE_PAYMENT',
    'COGS_JOURNAL',
    'DAILY_BATCH_TRANSIT_RECONCILIATION',
    'MANUFACTURING_JOURNAL',
  ] as const) {
    assert.equal(isFxGainLossJournalSuppressed('xero', type), false, `${type} must not be suppressed`)
    assert.equal(isFxGainLossJournalSuppressed(UNREGISTERED_CONNECTOR, type), false, `${type} must not be suppressed`)
  }
})
