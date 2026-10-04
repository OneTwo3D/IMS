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

  // o3d-remove-parked-connectors: the QuickBooks half was here, and it was the point of the case —
  // "the settlement action is connector-agnostic, so a marker that only ever appeared on Xero rows
  // would silently mean Xero only". Its reader is archived. The registry adapter below still carries
  // the field explicitly, which is the remaining evidence that the CONTRACT (not just one reader)
  // exposes it.

  // o3d-remove-parked-connectors: this skipped the FIRST `getSyncLogs` (the QuickBooks adapter's) and
  // checked the SECOND (Xero's). With one adapter left there is only one, so it takes the first.
  const registry = await source('lib/connectors/accounting-registry.ts')
  const getAt = registry.indexOf('async getSyncLogs(limit = 50) {')
  assert.notEqual(getAt, -1, 'the Xero adapter maps the row shape explicitly and must carry it')
  assert.match(registry.slice(getAt, getAt + 900), /settlementBasis: row\.settlementBasis/)
})

test('[o3d-anu8 / o3d-1e7sl] the sync page marks a row by its STANDING rather than showing a bare status and id', async () => {
  const client = await source('app/(dashboard)/sync/xero-client.tsx')
  assert.match(client, /const assertedBasis = isOperatorAssertedSettlement\(log\.settlementBasis\)/,
    'the basis is read from the COLUMN, never parsed out of the settlement note in errorMessage')
  // o3d-1e7sl (D2): the badge is the standing's, asked of ONE function, from all four columns the standing reads.
  const rowAt = client.indexOf('const assertedBasis =')
  const rowBody = client.slice(rowAt, rowAt + 5200)
  assert.match(rowBody, /describeLedgerStanding\(standingRow\)/)
  assert.match(rowBody, /abandonedBeforeRemoteCall: log\.abandonedBeforeRemoteCall/,
    'the pre-call proof reaches the page: without it a proven-unsent row would badge as unproven')
  assert.match(rowBody, /standing\.label !== null && \(/)
  assert.match(rowBody, /data-standing=\{standing\.standing\}/)
  // the external id cell still says whose id it is.
  assert.match(rowBody, /asserted by an operator, not confirmed by Xero/)
  assert.match(rowBody, /describeDocumentIdClaim\(standingRow\)/)
  // and the page no longer reads the id or the status by hand to decide what to say about the ledger.
  assert.doesNotMatch(rowBody, /log\.externalTransactionId\?\./)
})

test('[o3d-1e7sl D2] the connector-agnostic row, the Xero reader and the registry mapper CARRY the pre-call proof', async () => {
  const registry = await source('lib/connectors/accounting-registry.ts')
  const at = registry.indexOf('export type AccountingSyncLogRow = {')
  assert.match(registry.slice(at, registry.indexOf('}', at)), /\n\s*abandonedBeforeRemoteCall: boolean \| null\n/)
  assert.doesNotMatch(registry.slice(at, registry.indexOf('}', at)), /abandonedBeforeRemoteCall\?/)
  const getAt = registry.indexOf('async getSyncLogs(limit = 50) {')
  assert.match(registry.slice(getAt, getAt + 1100), /abandonedBeforeRemoteCall: row\.abandonedBeforeRemoteCall/)
  const xero = await source('app/actions/xero-sync.ts')
  const xeroAt = xero.indexOf('export async function getXeroSyncLogs')
  assert.match(xero.slice(xeroAt, xeroAt + 1500), /abandonedBeforeRemoteCall: r\.abandonedBeforeRemoteCall/)
  const action = await source('app/actions/accounting-sync.ts')
  const actionAt = action.indexOf('export type AccountingSyncLogRow = {')
  assert.match(action.slice(actionAt, action.indexOf('\n}\n', actionAt)), /\n\s*abandonedBeforeRemoteCall: boolean \| null\n/)
})

test('[o3d-1e7sl D3/D4] the orphan banner names an id by standing and the stranded loader selects the columns', async () => {
  const banner = await source('app/(dashboard)/sync/connector-orphan-banner.tsx')
  assert.match(banner, /describeDocumentIdClaim\(row\)/)
  assert.match(banner, /describeLedgerStanding\(row\)\.label !== null && \(/)
  assert.doesNotMatch(banner, /posted as \{row\.externalTransactionId\}/, 'the unqualified "posted as <id>" sentence is gone')
  const loader = await source('app/actions/accounting-stranded-rows.ts')
  const at = loader.indexOf('export async function getStrandedAccountingSyncRows')
  assert.match(loader.slice(at, at + 2600), /settlementBasis: true/)
  assert.match(loader.slice(at, at + 2600), /abandonedBeforeRemoteCall: true/)
})

test('[o3d-1e7sl Codex r1] the sync log, the orphan banner and the stranded-row source pass the WHOLE row (basis + flag + id) so a verified reversal is never badged "never sent"', async () => {
  const client = await source('app/(dashboard)/sync/xero-client.tsx')
  const at = client.indexOf('const standingRow = {')
  const block = client.slice(at, at + 700)
  for (const column of ['status: log.status', 'externalTransactionId: log.externalTransactionId', 'settlementBasis: log.settlementBasis', 'abandonedBeforeRemoteCall: log.abandonedBeforeRemoteCall']) {
    assert.ok(block.includes(column), `sync log passes ${column}`)
  }
  assert.match(client, /standing\.tone === 'proven'/)
  assert.doesNotMatch(client, /['"`]\s*(proven unsent|never sent)/, 'the page hardcodes no "never sent" wording: it all comes from the display module')
  const banner = await source('app/(dashboard)/sync/connector-orphan-banner.tsx')
  assert.match(banner, /describeLedgerStanding\(row\)/)
  assert.doesNotMatch(banner, /['"`]\s*never sent/)
  const display = await source('lib/domain/accounting/ledger-standing-display.ts')
  assert.equal((display.match(/'never sent'/g) ?? []).length, 1, 'exactly one label says "never sent": the recorded pre-call proof')
})

test('[o3d-1e7sl Codex r2] operator instruction strings never advise an unconditional re-post / reversal on a non-confirmed standing', async () => {
  const dialog = await source('app/(dashboard)/sync/settle-sync-row-control.tsx')
  assert.match(dialog, /check the accounting system, and ONLY if the document is not there hand-post it/)
  assert.doesNotMatch(dialog, /hand-post it in the accounting system and mark the posting handled\. If a document turns up/)
  const handled = await source('lib/domain/accounting/posting-mark-handled.ts')
  assert.match(handled, /post it by hand ONLY if [`']\s*\+ 'it is not there/)
  const docs = await source('help-docs/xero-sync.md')
  assert.match(docs, /check Xero first and, only if the document is not there, record it in\s+Xero by hand/)
  assert.doesNotMatch(docs, /To get the posting into the ledger, \*\*record it in/)
  const sales = await source('help-docs/sales.md')
  assert.match(sales, /check the accounting system for that journal and reverse it only if it exists there/)
  assert.doesNotMatch(sales, /\| Daily batch \| \*\*Finance reverses the batch entry\.\*\*/)
})
