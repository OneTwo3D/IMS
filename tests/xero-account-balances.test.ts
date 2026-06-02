import assert from 'node:assert/strict'
import test from 'node:test'

import { buildXeroAccountBalanceSnapshotInputs, parseXeroTrialBalanceRows } from '@/lib/connectors/xero/account-balances'
import { toDecimal } from '@/lib/domain/math/decimal'

test('parseXeroTrialBalanceRows walks nested report sections and calculates debit minus credit', () => {
  const rows = parseXeroTrialBalanceRows({
    Reports: [{
      Rows: [
        {
          RowType: 'Section',
          Title: 'Assets',
          Rows: [{
            RowType: 'Row',
            Cells: [
              {
                Value: '500 - Inventory Asset',
                Attributes: [
                  { Id: 'account', Value: 'xero-account-500' },
                  { Id: 'accountCode', Value: '500' },
                ],
              },
              { Value: '150.25' },
              { Value: '' },
            ],
          }],
        },
        {
          RowType: 'Section',
          Title: 'Expenses',
          Rows: [{
            RowType: 'Row',
            Cells: [
              { Value: '600 - Cost of Goods Sold' },
              { Value: '2,000.00' },
              { Value: '125.50' },
            ],
          }],
        },
      ],
    }],
  })

  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.externalAccountId, 'xero-account-500')
  assert.equal(rows[0]?.accountCode, '500')
  assert.equal(rows[0]?.accountName, 'Inventory Asset')
  assert.equal(rows[0]?.amount.toFixed(6), '150.250000')
  assert.equal(rows[1]?.accountCode, '600')
  assert.equal(rows[1]?.accountName, 'Cost of Goods Sold')
  assert.equal(rows[1]?.amount.toFixed(6), '1874.500000')
})

test('parseXeroTrialBalanceRows skips section and summary cells that are not account rows', () => {
  const rows = parseXeroTrialBalanceRows({
    Reports: [{
      Rows: [
        {
          RowType: 'Section',
          Cells: [{ Value: 'Total Assets' }, { Value: '10000' }, { Value: '' }],
          Rows: [{
            RowType: 'SummaryRow',
            Cells: [{ Value: 'Total Inventory' }, { Value: '5000' }, { Value: '' }],
          }],
        },
        {
          RowType: 'Row',
          Cells: [{ Value: '500 — Inventory Asset' }, { Value: '125.50' }, { Value: '' }],
        },
      ],
    }],
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.accountCode, '500')
  assert.equal(rows[0]?.accountName, 'Inventory Asset')
})

test('parseXeroTrialBalanceRows handles parenthesis negatives and empty numeric cells', () => {
  const rows = parseXeroTrialBalanceRows({
    Reports: [{
      Rows: [{
        RowType: 'Row',
        Cells: [{ Value: '600: Cost of Goods Sold' }, { Value: '' }, { Value: '(125.50)' }],
      }],
    }],
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.accountCode, '600')
  assert.equal(rows[0]?.amount.toFixed(6), '-125.500000')
})

test('parseXeroTrialBalanceRows uses explicit balance column when present', () => {
  const rows = parseXeroTrialBalanceRows({
    Reports: [{
      Rows: [{
        RowType: 'Row',
        Cells: [
          { Value: '500 Inventory Asset (GBP)' },
          { Value: '200.00' },
          { Value: '50.00' },
          { Value: '150.00' },
        ],
      }],
    }],
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.accountCode, '500')
  assert.equal(rows[0]?.accountName, 'Inventory Asset')
  assert.equal(rows[0]?.amount.toFixed(6), '150.000000')
})

test('buildXeroAccountBalanceSnapshotInputs reports partial matches and prefers external id', () => {
  const result = buildXeroAccountBalanceSnapshotInputs({
    balanceDate: '2026-06-01',
    baseCurrency: 'GBP',
    accounts: [
      { externalAccountId: 'account-x', code: '500', name: 'Inventory Asset' },
      { externalAccountId: 'account-missing', code: '600', name: 'COGS' },
    ],
    parsedRows: [
      { externalAccountId: 'other-account', accountCode: '500', accountName: 'Archived Inventory', amount: toDecimal('999') },
      { externalAccountId: 'account-x', accountCode: null, accountName: 'Inventory Asset', amount: toDecimal('123') },
    ],
  })

  assert.equal(result.snapshots.length, 1)
  const [snapshot] = result.snapshots
  assert.ok(snapshot)
  assert.equal(snapshot.externalAccountId, 'account-x')
  assert.equal(snapshot.accountName, 'Inventory Asset')
  assert.equal(toDecimal(snapshot.amountBase).toString(), '123')
  assert.deepEqual(result.errors, ['No Trial Balance row matched configured account 600 (COGS).'])
})
