'use server'

import { revalidatePath } from 'next/cache'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { getAccountingConnector } from '@/lib/connectors/accounting-registry'
import { accountMappingRuleKeys, validateAccountingAccountMapping } from '@/app/(dashboard)/sync/accounting-settings-fields'
import { db } from '@/lib/db'
import {
  lockIntegrationPluginSelection,
  readLockedPluginSelection,
  resolveActiveAccountingConnector,
  type PluginSelectionLockTx,
} from '@/lib/integration-plugin-selection-lock'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import { freshAuthFailureResult, requireInternalUser, requirePermission, requireRole } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import { probeLedgerSettlement } from '@/lib/connectors/accounting-settlement-probe'
import {
  classifyLedgerSettlement,
  describeAttempt,
  settlementMarkerFor,
} from '@/lib/domain/accounting/ledger-settlement-evidence'
import { effectiveTokenFor, isMoneyMovingSyncType } from '@/lib/domain/accounting/followup-retry-guard'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import { decideSettledRowReconciliation } from '@/lib/domain/accounting/settled-row-reconciliation'
import {
  cancelledSaleReleaseNote,
  describeCancelledSaleRelease,
  SALE_SCOPED_RELEASE_REFERENCE_TYPE,
  type ReleaseSaleState,
} from '@/lib/domain/accounting/cancelled-sale-release'
import { UNCLAIMED_ATTEMPT_REVISION, applyFencedAttemptDecision } from '@/lib/domain/accounting/sync-log-attempt'
import { OPERATOR_RELEASE_SETTLEMENT_BASIS } from '@/lib/domain/accounting/sync-row-settlement'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import {
  summarizeCrossConnectorOrphans,
  type ConnectorOrphanSummary,
} from '@/lib/domain/accounting/connector-orphans'
import {
  collectRejectedAccountingDocumentUpdateWarnings,
  type AccountingDocumentUpdateReference,
  type RejectedAccountingDocumentUpdateWarning,
} from '@/lib/domain/accounting/rejected-sync-warnings'
import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'
import type { MissingTaxRatePreviewResult, MissingTaxRateGenerateResult } from '@/lib/tax/generate-missing-tax-rates'

export type AccountingAccountRow = {
  id: string
  externalAccountId: string
  code: string | null
  name: string
  type: string
}

export type AccountingTaxCodeRow = {
  taxType: string
  name: string
  rate: number
}

export type AccountingSyncLogRow = {
  id: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  /**
   * o3d-e2mz: which attempt this row is currently on, for connectors whose processor stamps one.
   * A per-row operator decision must carry it back so the decision can be fenced to the attempt it
   * was made about (lib/domain/accounting/sync-log-attempt.ts).
   *
   * OPTIONAL on purpose: a connector that does not stamp an attempt revision reports none, rather
   * than reporting a 0 that reads like a real attempt. Absent and 0 both mean "cannot be fenced",
   * and applyFencedAttemptDecision refuses both — the caller never has to tell them apart.
   */
  attemptRevision?: number
  /**
   * o3d-anu8 — HOW this row reached its status: NULL for the connector's own writeback, and
   * `OPERATOR_ASSERTION` when a human typed the outcome and the document id in and IMS verified
   * nothing. The sync page renders an external id beside a status badge, and this is the only thing
   * that lets it say which of the two the reader is looking at.
   *
   * REQUIRED, unlike `attemptRevision` above, and the difference matters: an absent attempt revision
   * means "this connector cannot be fenced", which the decision path already refuses. An absent
   * basis would mean "connector-confirmed", which is a claim — and defaulting to the stronger claim
   * is the whole defect this column exists to stop.
   */
  settlementBasis: string | null
  syncedAt: string | null
  createdAt: string
}

export type AccountingConnectorSettings = Record<string, string>
export type AccountingConnectorSettingsMasked = AccountingConnectorSettings & { secretMasked: boolean }

export type AccountingConnectionStatus = {
  connected: boolean
  tenantName?: string
  /**
   * Why a stored connection is unusable, when it is (o3d-9tbz). Set together with `connected: false`
   * and `hasStoredToken: true` — an allow-list-blocked token is NOT a connection, but it is also not
   * the same thing as never having connected, and the operator has to be told which they are looking at.
   */
  blockedReason?: string
  /** A token row exists, so /sync must keep offering Disconnect — the refusal text tells them to use it. */
  hasStoredToken?: boolean
}

export type AccountingConnectorId = 'xero' | 'quickbooks'

export type AccountingSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /**
   * Scopes the connector asked for at consent but was NOT granted (o3d-g2i). Deliberately NOT part of
   * `ready`: an incomplete grant does not stop the connector, it stops the specific syncs that need the
   * missing scope, so blocking everything over it would be a worse outage than the fault. Empty when the
   * grant is complete AND when the connector does not record grants — unknown is never reported missing.
   */
  missingScopes: string[]
}

async function getActiveConnector(preferredConnector?: AccountingConnectorId): Promise<AccountingConnectorId | null> {
  if (preferredConnector === 'xero' && await isIntegrationPluginEnabled('xero')) return 'xero'
  if (preferredConnector === 'quickbooks' && await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  if (await isIntegrationPluginEnabled('xero')) return 'xero'
  if (await isIntegrationPluginEnabled('quickbooks')) return 'quickbooks'
  return null
}

async function getActiveAccountingConnector(preferredConnector?: AccountingConnectorId) {
  const connectorId = await getActiveConnector(preferredConnector)
  return connectorId ? getAccountingConnector(connectorId) : null
}

// audit-H4: live sync rows are claimable only by their own connector's processor.
const LIVE_ACCOUNTING_SYNC_STATUSES = ['PENDING', 'PROCESSING'] as const

/**
 * audit-H4: count PENDING/PROCESSING accounting sync rows whose connector is not
 * the active one — they will never be processed (each processor claims only its
 * own connector's rows), so switching connectors strands them silently.
 */
export async function getCrossConnectorOrphanSummary(): Promise<ConnectorOrphanSummary> {
  await requireInternalUser()
  const activeConnector = await getActiveConnector()
  const groups = await db.accountingSyncLog.groupBy({
    by: ['connector'],
    where: { status: { in: [...LIVE_ACCOUNTING_SYNC_STATUSES] } },
    _count: { id: true },
  })
  return summarizeCrossConnectorOrphans(
    groups.map((group) => ({ connector: group.connector, count: group._count.id })),
    activeConnector,
  )
}

export type FailedAccountingSyncSummary = {
  /** The active accounting connector (null when none is enabled). */
  connector: string | null
  /** Terminally-FAILED rows (retries exhausted) on the active connector. */
  failedCount: number
}

/**
 * audit-6vq0: count terminally-FAILED accounting sync rows for the active
 * connector so the sync dashboard can raise a prominent admin alert (the
 * per-row + Retry-All UI already exists, but only inside the sync log table).
 * CANCELLED rows (audit-46ry: cross-connector orphans deliberately abandoned)
 * are NOT FAILED, so they are correctly excluded — these are real failures.
 */
export async function getFailedAccountingSyncSummary(): Promise<FailedAccountingSyncSummary> {
  await requireInternalUser()
  const connector = await getActiveConnector()
  if (!connector) return { connector: null, failedCount: 0 }
  const failedCount = await db.accountingSyncLog.count({
    where: { connector, status: 'FAILED' },
  })
  return { connector, failedCount }
}


/**
 * Thrown when the active accounting connector CHANGED while a cancel was deciding what to
 * discard. Never surfaces as an error to the operator — it exists to abort the transaction, and
 * the caller converts it into a refusal (o3d-osl8 round 5, finding 2).
 */
class AccountingConnectorChangedError extends Error {
  constructor(readonly before: string | null, readonly after: string | null) {
    super(`Active accounting connector changed from ${before ?? 'none'} to ${after ?? 'none'} mid-cancel`)
  }
}

/**
 * audit-H4: bulk-cancel orphaned live sync rows. Marks them CANCELLED (audit-46ry)
 * so neither processor will claim them AND reconciliation / event-backfill sweeps
 * and FAILED dashboards (which scan explicit PENDING/PROCESSING/SYNCED/FAILED lists)
 * don't treat them as unresolved failures or re-queue the underlying document.
 * Records a clear reason and an activity log. When `connector` is given, only that
 * connector's orphans are cancelled; otherwise every non-active connector's live
 * rows are cancelled.
 *
 * FENCED AGAINST A CONCURRENT CONNECTOR SWITCH (o3d-osl8 round 5, finding 2; round 6, finding 2).
 * Everything from "which connector is active" to the update itself runs in ONE transaction that
 * holds ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY — the same lock the plugin-state writers take —
 * AND row-locks the plugin setting rows themselves, via lockIntegrationPluginSelection.
 *
 * Why it needed more than the re-read that was already here. The action sampled the active
 * connector, derived a cancellation scope from it, and then ran an unfenced updateMany. If
 * another administrator switched Xero→QuickBooks in that window, the QuickBooks-scoped (or
 * unscoped) update marked QuickBooks PENDING rows CANCELLED *after* QuickBooks became the active
 * connector — discarding the live queue of the connector now in use. The later re-read only
 * corrected the survivor COUNT; nothing restores a cancelled row, and the activity log would
 * describe healthy work as abandoned.
 *
 * Three mechanisms, because they fail differently:
 *   • the ADVISORY LOCK serializes the switch against this sweep, for any writer that takes it
 *     (both app writers do — app/actions/settings.ts and app/actions/onboarding.ts);
 *   • the `FOR UPDATE` ROW LOCKS on the plugin setting rows (round 6, finding 2) fence the writers
 *     that DO NOT take the advisory lock, and those are real, not hypothetical: the full-chain
 *     quiesce harness writes plugin_xero_enabled with raw SQL over its own pg client, the e2e
 *     fixture scripts upsert it through Prisma, and resetDatabase deletes every settings row. None
 *     of them can commit a change to those rows while this transaction is open, which is what
 *     removes the post-check/pre-commit window the generation check alone left open;
 *   • the GENERATION CHECK re-reads the selection before commit and throws if it moved, which
 *     rolls the update back. With the row locks held it should be unreachable — it is kept as the
 *     loud failure if they are ever removed, not as the guarantee.
 *
 * Aborting DISCARDS NOTHING: the operator is told to look again, which is right, because the
 * scope they asked for was computed against a connector selection that no longer exists.
 */
export async function cancelOrphanedAccountingSyncRows(
  connector?: string,
): Promise<{ success: boolean; cancelled: number; error?: string; inFlightNotCancelled?: number }> {
  await requirePermission('settings')

  let outcome: {
    refusal?: string
    activeConnector: string | null
    cancelled: number
    inFlight: number
  }
  try {
    outcome = await db.$transaction(async (tx) => {
      // Taken FIRST, before anything is read: a lock acquired after the read it is meant to
      // protect protects nothing. lockIntegrationPluginSelection takes the advisory lock AND row-
      // locks the plugin setting rows `FOR UPDATE`, which is what fences the writers that never
      // take the advisory lock at all (round 6, finding 2).
      const selection = await lockIntegrationPluginSelection(tx)
      return cancelOrphanedRowsUnderLock(tx, selection, connector)
    })
  } catch (error) {
    if (error instanceof AccountingConnectorChangedError) {
      // Logged, because it is evidence: an operator saw a button do nothing, and the reason is a
      // second administrator switching connectors at the same moment.
      await logActivity({
        entityType: 'SYSTEM',
        action: 'accounting_sync_orphans_cancel_aborted',
        tag: 'sync',
        level: 'WARNING',
        description: `Aborted cancelling orphaned accounting sync rows for ${connector ?? 'non-active connector(s)'}: `
          + `the active accounting connector changed from ${error.before ?? 'none'} to ${error.after ?? 'none'} while the `
          + `request was running, so the rows targeted may belong to the connector that is now ACTIVE. Nothing was cancelled.`,
        metadata: { connector: connector ?? null, activeConnectorBefore: error.before, activeConnectorAfter: error.after },
      })
      return {
        success: false,
        cancelled: 0,
        error: 'The active accounting connector changed while this ran, so nothing was cancelled — '
          + 'the rows selected may now belong to the connector that is active. Reload and check before retrying.',
      }
    }
    throw error
  }

  if (outcome.refusal) return { success: false, cancelled: 0, error: outcome.refusal }
  const { activeConnector, cancelled, inFlight } = outcome

  if (cancelled > 0 || inFlight > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_orphans_cancelled',
      tag: 'sync',
      level: 'WARNING',
      description: inFlight > 0
        ? `Cancelled ${cancelled} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}. `
          + `${inFlight} row(s) were NOT cancelled: their claim had already been taken, so a request may `
          + `have reached the connector and been lost. Check ${connector ?? 'that connector'} for the `
          + `document(s); these rows stay in the orphan count and continue to block deleting their `
          + `orders until resolved (o3d-sref).`
        : `Cancelled ${cancelled} orphaned accounting sync row(s) for ${connector ?? 'non-active connector(s)'}${activeConnector ? ` (active connector: ${activeConnector})` : ''}.`,
      metadata: {
        cancelledCount: cancelled,
        connector: connector ?? null,
        activeConnector,
        // Separate because the remedy differs: these need a human to look at the connector.
        inFlightNotCancelled: inFlight,
      },
    })
  }

  revalidatePath('/sync')
  return { success: true, cancelled, inFlightNotCancelled: inFlight }
}

/**
 * The decide-and-update half, run inside the fenced transaction. Split out only so the lock, the
 * abort translation and the activity log stay legible above; it is not called from anywhere else.
 *
 * `selection` is the plugin state read by lockIntegrationPluginSelection — through the TRANSACTION
 * client, from rows this transaction holds `FOR UPDATE` (round 6, finding 2). It used to be read
 * through the ordinary pooled client via getActiveConnector, on the argument that a second
 * definition of "which connector is active" would be worse than the extra connection. That
 * argument was wrong in one specific way: a pooled read holds no lock, so nothing stopped a writer
 * that skips the advisory lock from committing a switch AFTER the verification below and BEFORE
 * this transaction committed. The single definition is preserved instead by
 * resolveActiveAccountingConnector, which is the same Xero-first rule getActiveConnector applies —
 * one rule, two sources, and the source used here is the one that can be locked.
 */
async function cancelOrphanedRowsUnderLock(
  tx: Pick<typeof db, 'accountingSyncLog'> & PluginSelectionLockTx,
  selection: IntegrationPluginState,
  connector?: string,
): Promise<{ refusal?: string; activeConnector: string | null; cancelled: number; inFlight: number }> {
  const activeConnector = resolveActiveAccountingConnector(selection)
  // Never cancel the active connector's own queue.
  if (connector && connector === activeConnector) {
    return { refusal: 'Cannot cancel sync rows for the active connector.', activeConnector, cancelled: 0, inFlight: 0 }
  }
  // With no active connector, an un-scoped cancel would wipe EVERY connector's
  // queue — require an explicit connector so a transient both-plugins-off state
  // can't silently destroy all pending work (audit-H4 review).
  if (!connector && !activeConnector) {
    return {
      refusal: 'No active accounting connector — specify which connector’s orphaned rows to cancel.',
      activeConnector,
      cancelled: 0,
      inFlight: 0,
    }
  }

  // o3d-sref: ONLY PENDING rows are cancelled. A PROCESSING row — stale claim or not — is left
  // exactly as it is.
  //
  // The two are not the same fact. A PENDING row is provably PRE-CALL: nothing was sent, so
  // "the ledger was never told" is true and retiring it asserts nothing that might be false.
  //
  // A PROCESSING row had its claim TAKEN, which means the processor may already have made its remote
  // call — they post BEFORE persisting SYNCED and the externalTransactionId — and then died without
  // recording the result. There is no external id to find, so nothing can settle it from here.
  // Retiring it as CANCELLED told the order delete guard the row was deliberately abandoned, the hard
  // delete was permitted, and a late remote success then wrote a document against an order that no
  // longer existed. Exactly what the o3d-5r8 claim protocol prevents, reached through this sweep
  // instead of a race on the claim.
  //
  // Leaving it PROCESSING is the whole fix: PROCESSING is already in LIVE_ACCOUNTING_SYNC_STATUSES,
  // so the delete guard blocks on it with no new state to introduce, propagate, retain, index or
  // surface. A previous attempt at this (PR #590) added a persisted ambiguity flag and needed a
  // coherent design across five subsystems to be correct; this needs none.
  //
  // THE COST, deliberately accepted: these rows stay in the live set, so the cross-connector orphan
  // count will not fall to zero for a connector that was switched off mid-flight. That is honest —
  // they ARE unresolved — and the sweep now reports them so an operator can see why. FAILED
  // dashboards are unaffected: they scan `status = 'FAILED'`, which this never produces.
  const scope = connector ? { connector } : { connector: { not: activeConnector ?? undefined } }

  const reason = `Cancelled: orphaned accounting sync row for ${connector ?? 'a non-active connector'} (no longer the active connector${activeConnector ? ` — now ${activeConnector}` : ''}).`
  const result = await tx.accountingSyncLog.updateMany({
    where: { AND: [scope, { status: 'PENDING' as const }] },
    // audit-46ry: CANCELLED (not FAILED) so these abandoned rows are excluded from
    // FAILED-scanning reconciliation/backfill sweeps and error dashboards.
    //
    // o3d-o97 r6: and `abandonedBeforeRemoteCall` records the ONE thing this sweep — alone among
    // the cancellers — can prove. The `status: 'PENDING'` predicate above is exactly the o3d-sref
    // argument written down: a PENDING row is PRE-CALL, nothing was sent, so its journal is in no
    // ledger. Every other reader of a cancelled row (the refund's open balance, the A2 un-stage,
    // the daily-batch recreate sweep) must otherwise treat CANCELLED as unproved, because the
    // processors post BEFORE persisting SYNCED. Writing the negative HERE, where it is known, is
    // what lets `recreateMissingDailyBatchLogs` rebuild a genuinely lost batch without guessing
    // from a status — and refuse on every cancelled row that does not carry it.
    //
    // It is set in the SAME UPDATE as the status, under the same predicate, so a row can never
    // carry the claim without having been cancelled from PENDING by this sweep.
    data: { status: 'CANCELLED', errorMessage: reason, processingStartedAt: null, abandonedBeforeRemoteCall: true },
  })

  // Counted, not cancelled — so the activity log explains why the orphan count did not reach zero.
  //
  // EVERY surviving PROCESSING row is counted, not just the stale ones. The update above leaves them
  // all, so scoping this count to `stale` would omit a row claimed moments before the connector
  // switch, or one that won the PENDING->PROCESSING race against the update. The action would then
  // report zero, write no explanation, and clear the banner notice — while the orphan count visibly
  // stayed non-zero on refresh. That is the "button reads as broken" outcome this count exists to
  // prevent, so it must match what actually survived rather than what was targeted.
  //
  // The scope is RE-DERIVED here rather than reusing the one the update ran under. activeConnector
  // was sampled before the update, so if another administrator activates the target connector in
  // between, the stale scope would count rows that now belong to the ACTIVE connector — and the
  // response and the permanent activity log would describe live, healthy work as switched-off and
  // possibly lost, while the refreshed banner correctly excluded it. Contradictory accounting
  // evidence is worse than a slightly stale count, so this reads the current state.
  // Re-read THROUGH THE TRANSACTION, from the rows it holds `FOR UPDATE`. Under READ COMMITTED
  // each statement takes a fresh snapshot, so this sees any switch that managed to commit.
  const activeNow = resolveActiveAccountingConnector(await readLockedPluginSelection(tx))

  // THE FENCE (round 5, finding 2; strengthened round 6, finding 2). The update above ran against a
  // scope derived from `activeConnector`; if the selection has moved, that scope may name the
  // connector that is now ACTIVE, and the rows just marked CANCELLED are its live queue. Throwing
  // rolls the update back — the only outcome that is recoverable, since no later read can un-cancel
  // a row.
  //
  // WHAT CHANGED. This check on its own was never sufficient, and round 5 described it as if it
  // were: it verifies at one instant and then commits at another, so an unlocked writer committing
  // in between still produced the exact bug. It is the `FOR UPDATE` row locks taken at the top of
  // the transaction that close that window — nothing outside can commit a change to those rows
  // until this transaction ends, so there is no post-check/pre-commit gap left to exploit.
  //
  // The check is KEPT because it is the loud failure if that ever regresses (a removed row lock, a
  // caller that reaches this function without going through lockIntegrationPluginSelection). It is
  // a cheap assertion on an invariant, not the invariant itself.
  if (activeNow !== activeConnector) throw new AccountingConnectorChangedError(activeConnector, activeNow)

  const stillOrphaned = connector
    ? (connector === activeNow ? null : { connector })
    : { connector: { not: activeNow ?? undefined } }

  const inFlight = stillOrphaned === null
    ? 0
    : await tx.accountingSyncLog.count({
      where: { AND: [stillOrphaned, { status: 'PROCESSING' as const }] },
    })

  return { activeConnector, cancelled: result.count, inFlight }
}

export async function getAccountingIntegrationConnector() {
  // o3d-1fel: not a facade — resolves plugin state (a DB-backed read) itself.
  await requireInternalUser()
  const connector = await getActiveConnector()
  if (!connector) return null
  return {
    id: connector,
    name: connector === 'xero' ? 'Xero' : 'QuickBooks',
    category: 'accounting' as const,
  }
}

// ---------------------------------------------------------------------------
// Connector dispatchers (o3d-512h)
//
// Each of these resolves the active accounting connector and hands off to a
// guarded connector action, and they used to carry no guard of their own on the
// strength of that hand-off. Two things make that justification false:
//
//   1. Several dispatchers RETURN BEFORE reaching the delegate — the
//      `if (!connector) return …` arm answers straight from this module, so on
//      that path there is no delegate and therefore no guard. Unguarded, they
//      told any authenticated principal whether an accounting integration is
//      enabled, and reached `isIntegrationPluginEnabled` (a database read) to
//      find out.
//   2. Some connector-side implementations answer from a constant instead of
//      calling a guarded action at all (getConnectionTestState, testConnection
//      and syncAccountBalanceSnapshots on the QuickBooks branch each return a
//      literal), so "the delegate is guarded" is not even true for every branch.
//
// WHICH gate, and why not the delegate's own: a dispatcher serves BOTH branches,
// and the two branches do not gate alike. The Xero delegates use
// requireRole('ADMIN') — o3d-512h round 3: they DID NOT when this paragraph was
// first written. xero-sync.ts's module-local `requireAdmin` was
// `requirePermission('sync')`, the same gate as the dispatcher and as QuickBooks,
// so "the stricter branch keeps enforcing its own" was false and MANAGER passed
// straight through. The sentence was not softened to match; xero-sync.ts:
// requireAdmin now enforces 'sync' AND the ADMIN role, and
// tests/security/accounting-dispatcher-authorization.test.ts asserts the
// difference between the two frames. quickbooks-sync.ts declares a module-local
// `requireAdmin` that is literally `requirePermission('sync')`, which also admits
// MANAGER. So
// there is no single "the delegate's gate" to copy, and copying Xero's stricter
// one would lock MANAGER out of the QuickBooks branch that legitimately admits
// it. Each dispatcher therefore takes the LOOSEST gate any branch's delegate
// applies, and the stricter branch keeps enforcing its own on top:
//
//   * 'sync' where the branches disagree (Xero ADMIN-only vs QuickBooks 'sync').
//   * requireRole('ADMIN','FINANCE') on syncAccountingAccountBalanceSnapshots,
//     which is what its delegate uses — gating it on 'sync' would lock FINANCE,
//     which holds no 'sync' permission, out of its own balance snapshots.
//   * 'settings.company' on the three tax-rate dispatchers, where BOTH branches'
//     delegates agree on that permission (settings.ts:{autoLink,previewMissing,
//     generateMissing}{Xero,QuickBooks}TaxRates).
//
// Reach change per principal: ADMIN unchanged. MANAGER passed the unguarded
// dispatcher before, and is now refused by the Xero delegate (round 3 — this is
// the part that was claimed but not implemented) / still admitted by the
// QuickBooks one; on the tax-rate dispatchers it was already
// refused by both delegates and is now refused one frame earlier. FINANCE keeps
// balance snapshots and loses the rest. WAREHOUSE, READONLY and SUPPLIER lose the
// early-return answer and the plugin-state read that produced it — which is the
// whole point: none of them could ever reach a delegate.
//
// Where the delegate additionally requires FRESH auth, that stays with the
// delegate on purpose: it is thrown from inside the try/catch that converts it
// into a step-up re-auth result for the client, and hoisting it here would turn
// that structured result into an unhandled throw.
//
// NOT claimed here: that the delegates themselves are all guarded. Six
// quickbooks-sync.ts exports carry no guard at all (see the allowlist note in
// tests/security/server-action-guard-coverage.test.ts). They are out of scope by
// owner instruction, and the gate below is what stands between them and an
// unauthorized caller *via this module* — it is not a gate on those exports,
// which remain separately addressable endpoints of their own.
// ---------------------------------------------------------------------------

export async function getAccountingSettingsMasked(): Promise<AccountingConnectorSettingsMasked> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return connector
    ? connector.getSettingsMasked()
    : getAccountingConnector('xero').getSettingsMasked()
}

export async function saveAccountingSettings(data: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  // o3d-1fel: the delegate (saveXeroSettings) is guarded, but this body reads the
  // CURRENT account-mapping settings and can return a validation error BEFORE
  // ever reaching that delegate — so unguarded it is both a read of the mapping
  // and an oracle for the validator. o3d-512h: 'sync' is the loosest gate the two
  // branches' delegates apply (saveQuickBooksSettings → requirePermission('sync');
  // saveXeroSettings → requireRole('ADMIN'), which still applies on its own path)
  // — see the dispatcher note above.
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  const resolved = connector ?? getAccountingConnector('xero')

  // Refuse to INTRODUCE a mapping collision that would silently corrupt a reconciliation.
  // Stage ran for months with allocated_inventory_account == transit_account and nothing
  // complained (o3d-f82); the damage surfaces later as a reconciliation "gap" that reads
  // like a data problem rather than the settings mistake it is. Fail here, where it is
  // fixable.
  //
  // Read the CURRENT values straight from the settings rows rather than via the connector,
  // for the same reason the validator no longer takes a connector id: resolution is
  // xero-first and ignores which connector the payload is actually for. Passing `current`
  // is what keeps this from locking an admin out of an unrelated save when a collision
  // already exists and the UI is not even showing the account selectors.
  const currentRows = await db.setting.findMany({ where: { key: { in: accountMappingRuleKeys() } } })
  const current = Object.fromEntries(currentRows.map((r) => [r.key, r.value ?? '']))
  const errors = validateAccountingAccountMapping(data, current)
  if (errors.length) return { success: false, error: errors.map((e) => e.message).join(' ') }

  return resolved.saveSettings(data)
}

export async function saveAccountingConnectionSettings(
  clientId: string,
  clientSecret: string,
  preferredConnector?: AccountingConnectorId,
): Promise<{ success: boolean; error?: string; message?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector(preferredConnector)
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  // audit-ohou: surface the fresh-auth gate (thrown deep in the connector) as a
  // structured result so the client can step-up re-auth and retry.
  try {
    return await connector.saveConnectionSettings(clientId, clientSecret)
  } catch (e) {
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    throw e
  }
}

export async function getAccountingConnectionTestState(): Promise<IntegrationConnectionTestState> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { status: 'never', testedAt: null, message: '', fingerprint: null }
  }
  return connector.getConnectionTestState()
}

export async function testAccountingConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  return connector.testConnection()
}

export async function getAccountingConnectionStatus(): Promise<AccountingConnectionStatus> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getConnectionStatus()
}

export async function connectAccountingConnector(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
  preferredConnector?: AccountingConnectorId,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector(preferredConnector)
  if (!connector) {
    return { success: false, error: 'Enable Xero or QuickBooks first.' }
  }
  // audit-ohou: same step-up passthrough for the OAuth connect path.
  try {
    return await connector.connect(clientId, clientSecret, origin, returnPath)
  } catch (e) {
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    throw e
  }
}

export async function disconnectAccountingConnector(): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).disconnect()
}

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).syncAccounts()
}

export async function syncAccountingAccountBalanceSnapshots(balanceDate?: string): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  // Matches the delegate exactly: FINANCE holds no 'sync' permission, so gating
  // this on 'sync' would lock a legitimate role out of its own balance snapshots.
  await requireRole('ADMIN', 'FINANCE')
  const connector = await getActiveAccountingConnector()
  if (!connector) {
    return { fetched: 0, persisted: 0, skipped: 0, errors: ['Enable Xero or QuickBooks first.'] }
  }
  return connector.syncAccountBalanceSnapshots(balanceDate)
}

export async function getAccountingAccounts(): Promise<AccountingAccountRow[]> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getAccounts()
}

export async function fetchAccountingTaxRates(
  opts?: { allowCache?: boolean },
): Promise<AccountingTaxCodeRow[]> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).fetchTaxRates(opts)
}

export async function autoLinkAccountingTaxRates(): Promise<{
  success: boolean
  linked: number
  alreadyLinked: number
  unmatched: string[]
  externalRatesCount: number
  error?: string
}> {
  await requirePermission('settings.company')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).autoLinkTaxRates()
}

/**
 * Preview which tax rates would be created in the active accounting connector
 * for active, unmapped IMS rates with no existing external name-match.
 * Read-only — nothing is written to the accounting system. Connector-agnostic.
 */
export async function previewMissingAccountingTaxRates(): Promise<MissingTaxRatePreviewResult> {
  await requirePermission('settings.company')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).previewMissingTaxRates()
}

/**
 * Create the confirmed missing tax rates in the active accounting connector and
 * map each back onto its IMS rate. Only writes the user-confirmed IMS rate ids.
 * Connector-agnostic.
 */
export async function generateMissingAccountingTaxRates(
  taxRateIds: string[],
  reportTypeOverrides?: Record<string, string>,
): Promise<MissingTaxRateGenerateResult> {
  await requirePermission('settings.company')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).generateMissingTaxRates(taxRateIds, reportTypeOverrides)
}

export async function getAccountingSyncLogs(limit = 50): Promise<AccountingSyncLogRow[]> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getSyncLogs(limit)
}

export async function getRejectedAccountingDocumentUpdateWarnings(
  references: AccountingDocumentUpdateReference[],
  limit = 10,
): Promise<RejectedAccountingDocumentUpdateWarning[]> {
  await requireInternalUser()
  return collectRejectedAccountingDocumentUpdateWarnings(db, references, limit)
}

export async function triggerAccountingSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).triggerSync()
}

/**
 * o3d-e2mz: a per-row retry must carry the attempt revision the operator was shown
 * (AccountingSyncLogRow.attemptRevision), so the connector can refuse it when the row has moved on to a
 * different attempt since. Connectors that stamp no revision report none and ignore it. Omit both for the
 * bulk "Retry All".
 *
 * o3d-0m56: `refused` rides back out with it — the connector guard can allow some rows and refuse
 * others in one call, and dropping the count here reports partial success as plain success.
 */
export async function retryFailedAccountingSync(
  entryId?: string,
  expectedAttemptRevision?: number,
): Promise<{ success: boolean; reset: number; refused?: number; error?: string }> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).retryFailedSync(entryId, expectedAttemptRevision)
}

/**
 * Declare a FAILED payment entry SETTLED, on the strength of the settlement the ledger actually
 * holds (o3d-0m56 round 3).
 *
 * This is the exit from the state every other guard in o3d-0m56 creates: a payment that reached the
 * ledger but lost its response leaves a row that can never be retried and never posts, and goes on
 * blocking the next receipt for that order. Without this the operator can see exactly what happened
 * and has no button that changes anything.
 *
 * It is NOT a "mark as done": it refuses unless IMS can see the matching settlement itself, and it
 * writes back the remote id it matched, so afterwards the row says WHICH payment settled it.
 */
export async function reconcileSettledAccountingSyncRow(
  entryId: string,
): Promise<{ success: boolean; error?: string; externalTransactionId?: string | null }> {
  await requirePermission('settings')
  try {
    const row = await db.accountingSyncLog.findUnique({
      where: { id: entryId },
      select: { id: true, connector: true, type: true, status: true, referenceType: true, referenceId: true, payload: true },
    })
    if (!row || (row.connector !== 'xero' && row.connector !== 'quickbooks')) {
      return { success: false, error: 'That sync entry no longer exists.' }
    }
    const connector = row.connector

    // Read the ledger BEFORE opening the transaction: a network call inside the scope lock would
    // let one slow remote block every payment enqueue in the system.
    const probe = await probeLedgerSettlement(connector, { type: row.type, payload: row.payload })
    const settlement = classifyLedgerSettlement(
      describeAttempt(row.type, row.payload, settlementMarkerFor(effectiveTokenFor(connector, row))),
      probe,
    )
    const decision = decideSettledRowReconciliation({ row, settlement, isMoneyMoving: isMoneyMovingSyncType })
    if (!decision.resolve) return { success: false, error: decision.reason }

    // Under the scope lock and fenced on FAILED, so this cannot race a retry or an automatic
    // revival of the same row — and cannot resolve a row that has meanwhile gone live.
    const applied = await db.$transaction(async (tx) => {
      await lockFollowUpScope(tx, {
        connector,
        type: row.type,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
      })
      return tx.accountingSyncLog.updateMany({
        where: { id: entryId, status: 'FAILED' },
        data: {
          status: 'SYNCED',
          syncedAt: new Date(),
          errorMessage: null,
          ...(decision.externalTransactionId ? { externalTransactionId: decision.externalTransactionId } : {}),
        },
      })
    })
    if (applied.count === 0) {
      return { success: false, error: 'That entry changed while it was being reconciled. Reload and look again.' }
    }

    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_row_reconciled',
      tag: 'sync',
      level: 'WARNING',
      description: `Reconciled ${row.type} for ${row.referenceType} ${row.referenceId} against a settlement `
        + `already in the ledger: ${decision.detail}. Nothing was posted.`,
      metadata: {
        syncLogId: entryId,
        connector,
        type: row.type,
        externalTransactionId: decision.externalTransactionId,
      },
    })
    revalidatePath('/sync')
    return { success: true, externalTransactionId: decision.externalTransactionId }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * RE-CHECK THE SALE AND RELEASE A ROW THE SWEEP RETIRED (o3d-psvi).
 *
 * The one exit from the state described at the top of
 * lib/domain/accounting/cancelled-sale-release.ts: a sales-order document that really did post, whose
 * sync row was retired to CANCELLED because the sale was not live at the time, and whose sale is live
 * again. Without it the operator can see a real invoice sitting unlinked in the ledger and has no
 * button that changes anything, while every other control answers "already CANCELLED".
 *
 * IT POSTS NOTHING AND ASSERTS NOTHING. It reads the sale under the sale's own row lock, inside the
 * transaction that writes, and on that evidence alone moves the row back to SYNCED so the ordinary
 * back-reference repair sweep can finish the link and the outstanding follow-ups. Every judgement
 * about WHETHER the work is owed stays where it already lives — the sweep re-reads the sale itself
 * before it releases anything, so a sale that is cancelled again between this call and the next pass
 * is retired again rather than repaired.
 *
 * THE READ IS INSIDE THE WRITE'S TRANSACTION AND UNDER THE ORDER LOCK. Reading the sale first and
 * writing afterwards is the check/use race the sweep's own gate was rewritten to close: a
 * cancellation landing in between would be overwritten by a decision taken before it.
 *
 * FENCED ON THE ATTEMPT the operator was shown, and on `expectedStatus: 'CANCELLED'`, so a row that
 * moved under them — released by somebody else, retired again, re-driven — is refused rather than
 * written over. Both existing entry points (per-row retry and Retry All) stay FAILED-only; this is a
 * separate affordance because the two CANCELLED terminal states it has to tell apart are
 * indistinguishable to a status filter.
 */
export async function releaseRetiredAccountingSyncRowForLiveSale(
  entryId: string,
  expectedAttemptRevision: number,
): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings')
  try {
    const row = await db.accountingSyncLog.findUnique({
      where: { id: entryId },
      select: {
        id: true, connector: true, type: true, status: true, referenceType: true, referenceId: true,
        externalTransactionId: true, settlementBasis: true, backReferenceCheckedAt: true,
      },
    })
    if (!row) return { success: false, error: 'That sync entry no longer exists.' }

    const now = new Date()
    // o3d-psvi r3 (Codex HIGH) — THE TRY IS OUTSIDE THE TRANSACTION, NOT INSIDE IT.
    //
    // The lock is a raw `SELECT … FOR UPDATE`. Inside a Prisma interactive transaction a FAILED
    // STATEMENT ABORTS THE POSTGRES TRANSACTION: every statement after it raises 25P02
    // ("current transaction is aborted, commands ignored until end of transaction block") whatever
    // the application code does with the first error. So catching the lock failure INSIDE the
    // transaction and carrying on to the row re-read did not produce the UNREADABLE refusal this
    // module argues for — it produced a raw Prisma 25P02 escaping to the operator, and the third
    // state could not occur in production at all.
    //
    // `decideSaleRelease` in the Xero sync processor has had this right from the start: it wraps the
    // whole `db.$transaction` call and maps ANY throw to SALE_UNREADABLE. Same shape here. The
    // guarantee the refusal makes — "NOTHING was changed, the row is exactly as it was" — is
    // strictly stronger this way, because it is the transaction ROLLBACK that provides it rather
    // than an argument about which statements ran.
    let outcome: { released: true } | { released: false; reason: string }
    try {
      outcome = await db.$transaction(async (tx) => {
        // The sale is read HERE, not before the transaction: `describeCancelledSaleRelease` refuses on
        // what the sale says, and a decision taken outside the lock is a decision about a row that can
        // move before it is spent.
        //
        // FIRST of the three steps, and the order is the point (o3d-psvi r2): lock the sale, prove it
        // live, THEN re-read the row — so the row's shape is read after everything that could have been
        // waiting on the lock has finished writing.
        let sale: ReleaseSaleState
        if (row.referenceType !== SALE_SCOPED_RELEASE_REFERENCE_TYPE) {
          // Not a sale-scoped row at all; the decision refuses on the reference type and never reads a
          // state, so nothing is locked for it. Naming it UNREADABLE would be a different, wrong reason.
          sale = 'MISSING'
        } else {
          // No local try. A lock timeout, a lost deadlock or a dropped connection ABORTS this
          // transaction, so there is nothing left for this scope to do with the error except let it
          // reach the handler below, which is the only place that can honestly answer "nothing was
          // changed".
          await lockSalesOrder(tx, row.referenceId)
          const order = await tx.salesOrder.findUnique({ where: { id: row.referenceId }, select: { status: true } })
          sale = order === null ? 'MISSING' : order.status === 'CANCELLED' ? 'CANCELLED' : 'LIVE'
        }

        // o3d-psvi r2 (Codex HIGH) — AND THE ROW'S SHAPE IS RE-READ INSIDE THE TRANSACTION THAT WRITES,
        // AFTER THE LOCK.
        //
        // The read above the transaction is what the operator was SHOWN, and it is what the fence is
        // aimed at; it is not evidence about the row at the moment of the write. Every refusal here —
        // the basis column, the already-stamped verdict, the document id, the type pair — is about the
        // row's SHAPE, and a shape read outside the transaction is one a concurrent sweep can have moved
        // since. That mattered less while the revision alone had to move for a decision to be refused;
        // it matters now, because the adoption below deliberately accepts a revision that has NOT moved,
        // so the row's own columns are the only witness left. Releasing a row the sweep has meanwhile
        // stamped would produce exactly the thing this issue is named for: a remedy nothing performs.
        const fresh = await tx.accountingSyncLog.findUnique({
          where: { id: entryId },
          select: {
            id: true, connector: true, type: true, status: true, referenceType: true, referenceId: true,
            externalTransactionId: true, settlementBasis: true, backReferenceCheckedAt: true,
          },
        })
        if (!fresh) {
          return { released: false as const, reason: 'That sync entry no longer exists.' }
        }
        // The sale that was locked is the sale this decision is about. `referenceType`/`referenceId` are
        // never rewritten on a sync row, so this cannot fire in practice — which is the reason to assert
        // it rather than to assume it, because if it ever did the lock would be protecting another sale.
        if (fresh.referenceType !== row.referenceType || fresh.referenceId !== row.referenceId) {
          return {
            released: false as const,
            reason: 'This sync entry now points at a different document, so the sales order that was checked is not '
              + 'the one it belongs to. Nothing was changed. Reload the sync log and look at what it shows.',
          }
        }

        const decision = describeCancelledSaleRelease(fresh, sale)
        if (!decision.release) return { released: false as const, reason: decision.reason }

        // o3d-psvi r2 (Codex HIGH) — A REFUSAL MUST CARRY A REMEDY AN OPERATOR CAN PERFORM, AND THIS
        // ONE COULD NOT BE PERFORMED AT ALL FOR THE POPULATION IT WAS WRITTEN FOR.
        //
        // `applyFencedAttemptDecision` refuses revision 0 as UNFENCED_ATTEMPT unless adoption is asked
        // for, and this action never asked. Revision 0 means no processor that participates in the
        // fence has ever claimed the row — which is the state the attempt-revision migration
        // deliberately left EVERY pre-existing row in, and the state a row retired by the sweep before
        // any claim stays in for ever. So the one control written to rescue a retired row refused
        // exactly the retired rows there are, and its refusal named a claim that is never coming.
        //
        // ADOPTION IS SOUND HERE, and the argument is about the revision rather than about the
        // connector (which is what accounting-settlement.ts's narrower door rests on). `attemptRevision`
        // only ever MOVES UP — `nextAttemptRevision` is the only writer and every claim increments it —
        // so a row that is still at 0 at the instant of the write is a row nothing has ever claimed,
        // and there is no later attempt for this decision to land on. `(id, status CANCELLED,
        // revision 0)` is therefore STRICTLY STRONGER than the `(id, status)` identity check it
        // replaces: it refuses everything that would refuse, plus every row that has since been
        // claimed. It bumps to 1 exactly as a processor's first claim would, so a second operator, or
        // a sweep that moves the status first, loses the swap and is told what moved.
        //
        // Narrow on purpose: adoption is offered only when the operator was ALSO looking at revision 0.
        // A row shown at a real attempt that has since fallen back to 0 cannot exist — the revision does
        // not go down — so this can only ever widen the door for the population that has no other one.
        const adoptUnfencedAttempt = expectedAttemptRevision === UNCLAIMED_ATTEMPT_REVISION

        const applied = await applyFencedAttemptDecision(tx, {
          id: fresh.id,
          expectedAttemptRevision,
          expectedStatus: 'CANCELLED',
          adoptUnfencedAttempt,
          data: {
            status: 'SYNCED',
            // The retirement cleared this. The row is being recorded as posted again, and the only
            // instant this code can honestly name is now — the original post time did not survive.
            syncedAt: now,
            errorMessage: cancelledSaleReleaseNote(fresh.externalTransactionId ?? '', now),
            // o3d-psvi r3 (Codex MEDIUM) — WHO REACHED THIS STATUS, IN THE COLUMN AND NOT IN THE NOTE.
            //
            // The retirement this undoes is reachable from EITHER SYNCED or FAILED and preserves
            // neither, so the SYNCED written here is not a restatement of anything the connector said
            // — it is an operator's write. Unmarked it would be byte-identical to a connector
            // writeback, which is the exact condition `settlementBasis` exists to prevent, and this
            // branch's own refusal above reads that column rather than the note for precisely that
            // reason. The note is for a human; the column is what a reader may key on.
            //
            // OPERATOR_RELEASE, not OPERATOR_ASSERTION: the document id on this row is the
            // CONNECTOR's (an asserted row is refused before we get here), so the readers that fail
            // closed on an asserted id must not fire — see the constant for the full argument.
            settlementBasis: OPERATOR_RELEASE_SETTLEMENT_BASIS,
          },
        })
        if (!applied.ok) return { released: false as const, reason: applied.message }
        return { released: true as const }
      })
    } catch {
      // The transaction rolled back, so the row is exactly as it was — which is the only claim the
      // UNREADABLE refusal makes. Its WORDING is single-sourced from the decision function rather
      // than restated here, so the refusal an operator reads is the same one the pure tests pin.
      const refusal = describeCancelledSaleRelease(row, 'UNREADABLE')
      outcome = refusal.release
        // Unreachable: `describeCancelledSaleRelease` never releases on an UNREADABLE sale. Kept as a
        // refusal rather than a throw so a future edit to that function cannot turn a failed
        // transaction into a success here.
        ? { released: false, reason: 'The sales order could not be read, so nothing was changed. Try again.' }
        : { released: false, reason: refusal.reason }
    }

    if (!outcome.released) return { success: false, error: outcome.reason }

    await logActivity({
      entityType: 'SYSTEM',
      action: 'accounting_sync_row_released_for_live_sale',
      tag: 'sync',
      level: 'WARNING',
      description: `Released the retired ${row.type} sync row for ${row.referenceType} ${row.referenceId}: the sales `
        + 'order is live again, so the document it already posted can be linked. Nothing was sent to the accounting '
        + 'system; the back-reference repair sweep will write the link and enqueue the outstanding follow-ups.',
      metadata: {
        syncLogId: row.id,
        connector: row.connector,
        type: row.type,
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        externalTransactionId: row.externalTransactionId,
      },
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function getAccountingSyncReadiness(): Promise<AccountingSyncReadiness> {
  await requirePermission('sync')
  const connector = await getActiveAccountingConnector()
  return (connector ?? getAccountingConnector('xero')).getSyncReadiness()
}
