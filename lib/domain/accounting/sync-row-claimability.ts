import { isRegisteredAccountingConnector, type AccountingConnectorId } from '@/lib/connectors/accounting-registry'

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
//   • `triggerXeroSync` — the manual Sync button, reachable by ANYONE with the `sync` permission —
//     gates on `<connector>_sync_enabled` AND NOTHING ELSE. It does not resolve the active connector
//     at all, so the Xero plugin being switched off does not close it.
//
// So a row whose connector is not active but whose toggle is still on remains claimable, and settling
// it by adoption would be overwritten by the very next press of that button: the operation replays
// and the worker's later write lands on top of the settlement.
//
// THE QUESTION THIS MODULE ANSWERS IS "IS THERE A DEPLOYED WORKER THAT COULD STILL CLAIM THIS ROW?"
// and for a connector this build services the toggle is the best available answer to it — the ONE
// gate BOTH claim paths pass through, so `<connector>_sync_enabled !== 'true'` is NECESSARY for "no
// claim path for this connector exists".
//
// AND FOR A CONNECTOR THIS BUILD DOES NOT SERVICE, THE TOGGLE IS NOT AN ANSWER TO THAT QUESTION AT
// ALL — it is a stale row in the `settings` table (o3d-remove-parked-connectors round 2, Codex
// MEDIUM). Archiving QuickBooks removed its processor, its cron branch, its manual Sync action and
// its Sync-settings control, and deleted NO `quickbooks_sync_enabled` row: membership of that table
// is not a data-retention decision this branch took. Reading the survivor as proof of a claim path
// got the answer wrong IN THE UNSAFE DIRECTION — it reported a row claimable when nothing in the
// deployment can claim it, which refused adoption for every stranded QuickBooks row and told the
// operator to go and turn off a checkbox the Sync page no longer renders. A financial row with no
// claim path, no exit and instructions that cannot be followed.
//
// SO THE FIRST QUESTION IS WHETHER THE CONNECTOR IS IN THE ACTIVE CODEBASE, and it is asked of the
// ONE place that already answers it: `isRegisteredAccountingConnector` in
// lib/connectors/accounting-registry.ts. That predicate is keyed off `ACCOUNTING_CONNECTORS`, which
// is what the cron branch, both `resolveActiveAccountingConnector` copies, the settings-field
// builder and the connector factory are all driven by — so "retired" has one spelling here, not a
// second hand-written list that can disagree with the registry about who exists. A connector with no
// registration has no processor to select its rows: every candidate and claim query in
// lib/connectors/xero/sync-processor.ts is scoped `connector: XERO_CONNECTOR`, so a row naming
// anything else is invisible to it. Nothing can claim such a row, ever, so it is QUIESCED
// unconditionally and its rows stay settleable.
//
// THE ONE PREMISE THAT IS A DEPLOYMENT FACT RATHER THAN A CODE FACT, stated because the finding
// asked for it: "not in this build" equals "not in the deployment" only because IMS runs as ONE Next
// server. Both claim paths are inside it — `app/api/cron/accounting-sync/route.ts` (the scheduler
// calls an HTTP route, it does not run a worker of its own) and `triggerXeroSync` — and there is no
// standalone accounting worker anywhere in the tree. A rolling deployment serving two binaries at
// once against one database would break that equivalence: the older one would call a connector it no
// longer registers quiesced while the newer one still processed its rows. IMS is not deployed that
// way (scripts/deploy.sh resets the tree and restarts the single service), and a second accounting
// connector would be REGISTERED in both binaries anyway, so the window is closed for every value the
// registry has ever held rather than merely narrow.
//
// THE TOGGLE IS STILL NOT SUFFICIENT FOR A LIVE CONNECTOR, AND AN EARLIER VERSION OF THIS COMMENT
// CLAIMED IT WAS (round 7, Codex HIGH). Both gates READ the setting and then call the processor with
// nothing in between, so a run admitted a moment before the toggle was turned off keeps running and
// still claims rows; its claim leaves the row PROCESSING at attempt revision 0, which is exactly what
// the adoption compare-and-swap matches; and a writeback that updates the row by id with no claim or
// attempt fence can land on top of a settlement made in between. Nothing in IMS reports an in-flight
// run. For a LIVE connector this predicate therefore establishes that no NEW claim will be
// ADMITTED — not that the row is quiet. That residual is filed as o3d-4b5p. It does NOT apply to an
// archived connector, where there is no run to be in flight: the code that would have to be running
// is not in the deployment.
//
// This module is that predicate, kept pure so the rule is unit-testable
// without a database and shared verbatim by the read model (which decides whether the control is
// OFFERED) and the settlement action (which decides whether the adoption is ALLOWED). Two copies of
// this rule drifting apart is a control the UI offers and the action refuses, or worse.
// ---------------------------------------------------------------------------

/**
 * The setting BOTH claim paths of each REGISTERED accounting connector gate on — the cron branch and
 * the manual Sync action. Verified against app/api/cron/accounting-sync/route.ts and
 * app/actions/xero-sync.ts (triggerXeroSync); pinned by a test that reads that action.
 *
 * TOTAL OVER `AccountingConnectorId`, so registering a connector without naming the toggle its claim
 * paths gate on is a `tsc` error here rather than a silent "cannot be shown to be quiesced" at
 * runtime. And it holds NOTHING ELSE: a key for a connector this build does not service would be a
 * claim path that does not exist, which is the round-2 defect. `quickbooks_sync_enabled` was here and
 * is gone with the connector (o3d-remove-parked-connectors); the archived spelling is recoverable at
 * `git show archive/quickbooks-connector`.
 */
export const ACCOUNTING_SYNC_ENABLED_SETTING_KEYS: Readonly<Record<AccountingConnectorId, string>> = Object.freeze({
  xero: 'xero_sync_enabled',
})

/**
 * The toggle to read for a connector, or null when this build services no claim path for it — which
 * today means exactly "not registered", because the record above is total over the registry.
 */
export function accountingSyncEnabledSettingKey(connector: string): string | null {
  if (!isRegisteredAccountingConnector(connector)) return null
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
 * TWO CASES, and they are different facts:
 *
 *   • THE CONNECTOR IS NOT IN THIS BUILD. No processor, no cron branch, no Sync action, no control
 *     that writes its toggle. Nothing can claim the row and nothing ever will again, whatever a
 *     left-behind `settings` row says. Quiesced, unconditionally.
 *   • THE CONNECTOR IS LIVE. The stored toggle is the one gate both of its claim paths pass through,
 *     so it is the answer — read exactly as the gates read it. `syncEnabledValue` is the raw
 *     `Setting.value`: `'true'` and nothing else means enabled, so a missing row (null) or any other
 *     string is off, which is the same comparison `triggerXeroSync` makes.
 *
 * A LIVE CONNECTOR WITH NO TOGGLE NAMED is the conservative answer rather than the convenient one:
 * it is a claim path this module cannot account for. `tsc` keeps that unreachable (the record above
 * is total over the union), so it is a fail-closed guard against that totality being widened away
 * rather than a branch with behaviour of its own.
 */
export function isAccountingConnectorQuiesced(connector: string, syncEnabledValue: string | null | undefined): boolean {
  if (!isRegisteredAccountingConnector(connector)) return true
  if (accountingSyncEnabledSettingKey(connector) === null) return false
  return syncEnabledValue !== 'true'
}

/**
 * The adoption precondition, in full.
 *
 * BOTH halves are required and they are different facts. Being off the active connector is what
 * puts the row in the stranded list and out of every log view; nothing being able to claim it is
 * what makes the abandoned attempt the only one the row can ever have had. Dropping either one
 * re-opens a different hole: without the first, a row the running processor is about to claim would
 * be adoptable; without the second, a row the manual Sync button can still reclaim would be.
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
 *
 * IT CAN ONLY EVER NAME A CONTROL THAT EXISTS (round 2, Codex MEDIUM). The key comes from the
 * registered roster, so an archived connector cannot be sent a lever that was archived with it —
 * and an archived connector never reaches this function anyway, because
 * `isAccountingConnectorQuiesced` answers `true` for it and the control is OFFERED rather than
 * refused. The unregistered arm below is therefore unreachable by construction from both callers;
 * it is kept because this is an exported pure function, and it names nothing an operator would go
 * looking for.
 */
export function describeStillClaimableStrandedRow(connector: string): string {
  const key = accountingSyncEnabledSettingKey(connector)
  if (key === null) {
    return `This row carries no attempt revision, and ${connector} is not a connector this build services, `
      + 'so IMS has nothing to name that would change the answer. It is refused rather than adopted; '
      + 'report the row rather than acting on this message.'
  }
  return `This row carries no attempt revision, so settling it would have to ADOPT the abandoned attempt — which is `
    + `only sound while nothing can claim the row. ${connector} sync is still ENABLED (${key}), and the manual `
    + `Sync button runs the ${connector} processor on that toggle ALONE, whichever connector is active — its `
    + 'stale-claim sweep would reclaim this row and replay the operation over the settlement. Turn '
    + `${key} off in Sync settings and the control appears here.`
}
