import assert from 'node:assert/strict'
import test from 'node:test'

import { isFxGainLossJournalSuppressed } from '@/lib/accounting'

// o3d-lgo.6.1: Xero posts realised/unrealised FX gain/loss natively and rejects
// manual-journal lines to its system AR/AP control accounts, so IMS suppresses
// its own FX journals for Xero only. QuickBooks keeps them.

test('FX gain/loss journals are suppressed for Xero (both realised and unrealised)', () => {
  assert.equal(isFxGainLossJournalSuppressed('xero', 'REALISED_FX_JOURNAL'), true)
  assert.equal(isFxGainLossJournalSuppressed('xero', 'UNREALISED_FX_JOURNAL'), true)
})

test('FX gain/loss journals are NOT suppressed for QuickBooks', () => {
  assert.equal(isFxGainLossJournalSuppressed('quickbooks', 'REALISED_FX_JOURNAL'), false)
  assert.equal(isFxGainLossJournalSuppressed('quickbooks', 'UNREALISED_FX_JOURNAL'), false)
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
    assert.equal(isFxGainLossJournalSuppressed('quickbooks', type), false, `${type} must not be suppressed`)
  }
})
