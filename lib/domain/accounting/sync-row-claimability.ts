// ---------------------------------------------------------------------------
// o3d-batch-ret round 5 (Codex HIGH #1) — "NOTHING CAN CLAIM THIS ROW" IS NOT THE SAME FACT AS
// "THIS ROW IS NOT ON THE ACTIVE CONNECTOR".
//
// Adoption — settling a row that carries no attempt revision — rests on ONE premise, and it is an
// absolute: the abandoned attempt in front of the operator is the ONLY attempt this row can ever
// have had. That is what makes a compare-and-swap on (id, revision 0, status) a sufficient identity
// for it, and it is the entire reason `describeAttemptAdoptionCaveat` can promise what it promises.
//
// Rounds 3 and 4 established that premise from the ACTIVE CONNECTOR alone: `buildStrandedSyncRowWhere`
// selects rows whose connector is not the active one, and `describeStrandedSyncRow` therefore passed
// `unclaimable: true` for every row on the page. The argument was that nothing participating in the
// attempt fence can claim a row on a retired connector.
//
// IT IS FALSE FOR EXACTLY THE ROWS IT WAS WRITTEN FOR. The active connector is resolved from the
// PLUGIN flags, Xero-first (`isIntegrationPluginEnabled`). The claim paths are gated on something
// else entirely:
//
//   • the accounting-sync cron branches on the plugin flag AND `<connector>_sync_enabled`;
//   • `triggerXeroSync` / `triggerQuickBooksSync` — the manual Sync buttons, reachable by ANYONE
//     with the `sync` permission — gate on `<connector>_sync_enabled` AND NOTHING ELSE. Neither
//     one resolves the active connector at all.
//
// So with Xero enabled and QuickBooks left enabled beside it — the very state the QuickBooks
// unrecorded-post record tells an operator to create, and which it correctly calls "a guarded
// state, not an impossible one" — every QuickBooks row is "stranded", and pressing the QuickBooks
// Sync button still runs `processPendingQuickBooksSync`, which reclaims stale PROCESSING rows.
// A row adopted and settled CANCELLED in that state can be reclaimed by the very next press: the
// customer email replays, and the worker's later write lands on top of the settlement.
//
// THE PREMISE THAT IS ACTUALLY TRUE is the sync toggle. It is the ONE gate BOTH claim paths pass
// through, so `<connector>_sync_enabled !== 'true'` is necessary and sufficient for "no claim path
// for this connector exists". This module is that predicate, kept pure so the rule is unit-testable
// without a database and shared verbatim by the read model (which decides whether the control is
// OFFERED) and the settlement action (which decides whether the adoption is ALLOWED). Two copies of
// this rule drifting apart is a control the UI offers and the action refuses, or worse.
//
// AN UNRECOGNISED CONNECTOR IS NEVER QUIESCED. The map below is the set of connectors whose claim
// paths this codebase can account for; anything else is a connector nobody has walked, so it gets
// the conservative answer rather than the convenient one.
// ---------------------------------------------------------------------------

/**
 * The setting BOTH claim paths of each accounting connector gate on — the cron branch and the
 * manual Sync action. Verified against app/api/cron/accounting-sync/route.ts,
 * app/actions/xero-sync.ts (triggerXeroSync) and app/actions/quickbooks-sync.ts
 * (triggerQuickBooksSync); pinned by a test that reads those three files.
 */
export const ACCOUNTING_SYNC_ENABLED_SETTING_KEYS: Readonly<Record<string, string>> = Object.freeze({
  xero: 'xero_sync_enabled',
  quickbooks: 'quickbooks_sync_enabled',
})

/** The toggle to read for a connector, or null when this codebase knows no claim path for it. */
export function accountingSyncEnabledSettingKey(connector: string): string | null {
  return ACCOUNTING_SYNC_ENABLED_SETTING_KEYS[connector] ?? null
}

/** Every toggle a page of rows on these connectors needs read. */
export function accountingSyncEnabledSettingKeysFor(connectors: Iterable<string>): string[] {
  const keys = new Set<string>()
  for (const connector of connectors) {
    const key = accountingSyncEnabledSettingKey(connector)
    if (key) keys.add(key)
  }
  return [...keys]
}

/**
 * Can NOTHING claim a row on this connector any more?
 *
 * `syncEnabledValue` is the raw `Setting.value`, exactly as the gates read it — `'true'` and
 * nothing else means enabled, so a missing row (null) or any other string is off, which is the
 * same comparison `triggerQuickBooksSync` makes.
 */
export function isAccountingConnectorQuiesced(connector: string, syncEnabledValue: string | null | undefined): boolean {
  if (accountingSyncEnabledSettingKey(connector) === null) return false
  return syncEnabledValue !== 'true'
}

/**
 * The adoption precondition, in full.
 *
 * BOTH halves are required and they are different facts. Being off the active connector is what
 * puts the row in the stranded list and out of every log view; the toggle being off is what makes
 * the abandoned attempt the only one the row can ever have had. Dropping either one re-opens a
 * different hole: without the first, a row the running processor is about to claim would be
 * adoptable; without the second, a row the manual Sync button can still reclaim would be.
 */
export function isStrandedRowUnclaimable(params: {
  connector: string
  activeConnector: string | null
  syncEnabledValue: string | null | undefined
}): boolean {
  return params.activeConnector !== params.connector
    && isAccountingConnectorQuiesced(params.connector, params.syncEnabledValue)
}

/**
 * Why the settle control is withheld from a stranded row whose connector can still claim it — and
 * the exact thing to turn off to get it back.
 *
 * Names the toggle rather than "retire the connector": retiring the PLUGIN is not what closes this,
 * because the manual Sync action never reads the plugin flag.
 */
export function describeStillClaimableStrandedRow(connector: string): string {
  const key = accountingSyncEnabledSettingKey(connector)
  if (key === null) {
    return `This row carries no attempt revision, and IMS cannot show that nothing will claim a ${connector} row, `
      + 'so settling it could be overwritten by a later attempt. It is refused rather than adopted.'
  }
  return `This row carries no attempt revision, so settling it would have to ADOPT the abandoned attempt — which is `
    + `only sound while nothing can claim the row. ${connector} sync is still ENABLED (${key}), and the manual `
    + `Sync button runs the ${connector} processor on that toggle ALONE, whichever connector is active — its `
    + 'stale-claim sweep would reclaim this row and replay the operation over the settlement. Turn '
    + `${key} off in Sync settings and the control appears here.`
}
