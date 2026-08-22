import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-anu8, site 8 — THE DISPLAY IS THE LAST READER IN THE CHAIN, AND IT HAD NO WAY TO TELL.
 *
 * A settled row renders identically to one the connector confirmed: the same SYNCED badge, an
 * external id in the same column. The operator looking at that page is the person expected to catch
 * everything the code cannot, and they were the only reader with no signal at all.
 *
 * Two halves, and the first is why the second was impossible: `AccountingSyncLogRow` — the
 * CONNECTOR-AGNOSTIC row every accounting view is built on — did not carry `settlementBasis`, so no
 * such view COULD show it however carefully each reader beneath it was fixed.
 *
 * Asserted on the SOURCE because the alternative is rendering a React tree through two server
 * actions and a connector registry, which would test the harness rather than the contract. The
 * mapper is the contract: `findMany` with no `select` already fetches the column from the database,
 * and every one of these mappers explicitly dropped it on the way out.
 */

async function source(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), 'utf8')
}

test('[o3d-anu8] the connector-agnostic sync-log row REQUIRES the settlement basis', async () => {
  const registry = await source('lib/connectors/accounting-registry.ts')
  const at = registry.indexOf('export type AccountingSyncLogRow = {')
  assert.notEqual(at, -1)
  const decl = registry.slice(at, registry.indexOf('}', at))
  // Required, not optional: an absent basis would read as "connector-confirmed", and defaulting to
  // the stronger claim is the defect the column exists to stop.
  assert.match(decl, /\n\s*settlementBasis: string \| null\n/)
  assert.doesNotMatch(decl, /settlementBasis\?/)

  const action = await source('app/actions/accounting-sync.ts')
  const actionAt = action.indexOf('export type AccountingSyncLogRow = {')
  assert.notEqual(actionAt, -1)
  assert.match(action.slice(actionAt, action.indexOf('}', actionAt)), /\n\s*settlementBasis: string \| null\n/)
})

test('[o3d-anu8] both connectors CARRY the basis out of their sync-log read', async () => {
  const xero = await source('app/actions/xero-sync.ts')
  const xeroAt = xero.indexOf('export async function getXeroSyncLogs')
  assert.notEqual(xeroAt, -1)
  assert.match(xero.slice(xeroAt, xeroAt + 1200), /settlementBasis: r\.settlementBasis/)

  // The settlement action is connector-agnostic — it writes this column on whichever row an operator
  // settles — so a marker that only ever appeared on Xero rows would silently mean "Xero only".
  const quickbooks = await source('app/actions/quickbooks-sync.ts')
  const qbAt = quickbooks.indexOf('export async function getQuickBooksSyncLogs')
  assert.notEqual(qbAt, -1)
  assert.match(quickbooks.slice(qbAt, qbAt + 1200), /settlementBasis: r\.settlementBasis/)

  const registry = await source('lib/connectors/accounting-registry.ts')
  const getAt = registry.indexOf('async getSyncLogs(limit = 50) {', registry.indexOf('async getSyncLogs(limit = 50) {') + 1)
  assert.notEqual(getAt, -1, 'the Xero adapter maps the row shape explicitly and must carry it')
  assert.match(registry.slice(getAt, getAt + 900), /settlementBasis: row\.settlementBasis/)
})

test('[o3d-anu8] the sync page marks an asserted row rather than showing a bare id', async () => {
  const client = await source('app/(dashboard)/sync/xero-client.tsx')
  assert.match(client, /const assertedBasis = isOperatorAssertedSettlement\(log\.settlementBasis\)/,
    'the basis is read from the COLUMN, never parsed out of the settlement note in errorMessage')
  // The marker sits with the STATUS, which is the thing being qualified, and the external id cell
  // says whose id it is.
  const rowAt = client.indexOf('const assertedBasis =')
  const rowBody = client.slice(rowAt, rowAt + 3000)
  assert.match(rowBody, /assertedBasis && \(/)
  assert.match(rowBody, /asserted/)
  assert.match(rowBody, /asserted by an operator, not confirmed by Xero/)
})
