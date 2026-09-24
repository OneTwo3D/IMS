import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccountingConnectorId } from '@/lib/connectors/accounting-registry'
import { summarizeCrossConnectorOrphans } from '@/lib/domain/accounting/connector-orphans'

/**
 * o3d-remove-parked-connectors — WHAT THIS FILE IS STILL PROVING, AND WHAT IT CANNOT.
 *
 * Every case here used to pit two REGISTERED connectors against each other, because a connector
 * SWITCH is what strands rows. With QuickBooks archived there is one registered accounting connector,
 * so no switch is possible and the summariser's population can only be rows naming a connector this
 * build no longer ships — which is exactly what a development database holds after that removal
 * (`AccountingSyncLog.connector = 'quickbooks'`).
 *
 * So the subject changes from "the other live ledger" to "a ledger this build cannot service", and
 * the assertions below are rewritten to say that, because it is the case that now matters: those rows
 * ARE orphans, they will never be claimed, and this summary is how they become visible and
 * cancellable. `summarizeCrossConnectorOrphans` compares plain strings and takes the active connector
 * as an argument, so it never needed the retired id to be in the union — which is why it keeps
 * working, and why the test can still exercise it honestly.
 *
 * WHAT IS LOST: nothing here shows the summariser handles a switch BETWEEN two live ledgers any more,
 * because there is only one. Recorded in docs/archive/quickbooks-connector-removal.md.
 */
const RETIRED_CONNECTOR = 'quickbooks'

test('rows for the active connector are not orphans', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 5 }],
    'xero',
  )
  assert.equal(summary.totalOrphans, 0)
  assert.deepEqual(summary.orphanGroups, [])
})

test('rows for a connector this build no longer services are orphans', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 3 }, { connector: RETIRED_CONNECTOR, count: 2 }],
    'xero',
  )
  assert.equal(summary.activeConnector, 'xero')
  assert.equal(summary.totalOrphans, 2, 'the retired connector\'s live rows are the orphans')
  assert.deepEqual(summary.orphanGroups, [{ connector: RETIRED_CONNECTOR, count: 2 }])
})

test('the ACTIVE connector is compared as given, even when it is not the first group', () => {
  // The rule is "not the active one", not "not the first one" — asserted separately because with a
  // single registered connector the two are otherwise indistinguishable here.
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: RETIRED_CONNECTOR, count: 2 }, { connector: 'xero', count: 3 }],
    'xero' as AccountingConnectorId,
  )
  assert.deepEqual(summary.orphanGroups, [{ connector: RETIRED_CONNECTOR, count: 2 }])
})

test('with no active connector, every live row is an orphan', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: 'xero', count: 4 }, { connector: RETIRED_CONNECTOR, count: 1 }],
    null,
  )
  assert.equal(summary.totalOrphans, 5)
  assert.deepEqual(summary.orphanGroups.map((g) => g.connector), [RETIRED_CONNECTOR, 'xero'])
})

test('zero-count groups are ignored', () => {
  const summary = summarizeCrossConnectorOrphans(
    [{ connector: RETIRED_CONNECTOR, count: 0 }],
    'xero',
  )
  assert.equal(summary.totalOrphans, 0)
  assert.deepEqual(summary.orphanGroups, [])
})
