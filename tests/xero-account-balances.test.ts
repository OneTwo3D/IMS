import assert from 'node:assert/strict'
import test from 'node:test'

import { parseXeroTrialBalanceRows } from '@/lib/connectors/xero/account-balances'

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
