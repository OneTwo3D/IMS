import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeCrossConnectorOrphans } from '@/lib/domain/accounting/connector-orphans'

test('rows for the active connector are not orphans', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 5 }],
    'xero',
  )
  assert.equal(summary.totalOrphans, 0)
  assert.deepEqual(summary.orphanGroups, [])
})

test('rows for a non-active connector are orphans (Xero→QuickBooks switch)', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 3 }, { connector: 'quickbooks', count: 2 }],
    'quickbooks',
  )
  assert.equal(summary.activeConnector, 'quickbooks')
  assert.equal(summary.totalOrphans, 3)
  assert.deepEqual(summary.orphanGroups, [{ connector: 'xero', count: 3 }])
})

test('with no active connector, every live row is an orphan', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 4 }, { connector: 'quickbooks', count: 1 }],
    null,
  )
  assert.equal(summary.totalOrphans, 5)
  assert.deepEqual(summary.orphanGroups.map((g) => g.connector), ['quickbooks', 'xero'])
})

test('zero-count groups are ignored', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'quickbooks', count: 0 }],
    'xero',
  )
  assert.equal(summary.totalOrphans, 0)
  assert.deepEqual(summary.orphanGroups, [])
})
