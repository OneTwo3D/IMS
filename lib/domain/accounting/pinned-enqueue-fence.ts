/**
 * NOTHING MAY ANSWER FOR A PINNED ENQUEUE BEFORE THE FENCE HAS SPOKEN (o3d-i0o6 r9, Codex round 8,
 * HIGH).
 *
 * WHAT ROUND 8 CLOSED, AND WHERE IT LEFT A GATE IN THE FENCE. r8 put the pinned-ledger verdict under
 * the plugin-selection lock ON THE INSERTING TRANSACTION, so no connector switch can commit between
 * the verdict and the write. That holds. What it did not do is stop anything else answering FIRST:
 * both connector queues read their own settings before opening that transaction, and both returned
 * `not-configured` from there. So:
 *
 *   1. the facade's unlocked pooled check accepts the pin — Xero is the active ledger when it looks;
 *   2. a connector switch commits (`plugin_xero_enabled` false, `plugin_quickbooks_enabled` true);
 *   3. the queue's own `xero_sync_enabled` read finds the toggle off and returns `not-configured`
 *      BEFORE the transaction — so `pinnedLedgerIsServicedUnderLock` never runs at all.
 *
 * WHY THAT IS MONEY AND NOT TIDINESS. `not-configured` is the ONE no-op the refund obligation ledger
 * lets SETTLE an obligation (`lib/domain/sales/refund-accounting-obligations.ts`: it settles when the
 * reason is `not-configured` and the pinned connector's own `willPost` verdict, taken when the
 * hand-off opened, was already false). So a pinned ALLOCATION_REVERSAL / UNEARNED_REV_REVERSAL can be
 * marked settled with NO reversal row anywhere, on a ledger that is no longer the one being serviced —
 * while the ledger that IS being serviced would have accepted the posting. The obligation is
 * discharged against a configuration that has been retired. `refused` is the truthful answer there:
 * the posting is owed, `accountingRetryRequired` stays set, and nothing is silently written off.
 *
 * THE RULE. A pin is a CLAIM ABOUT WHICH LEDGER, and the only trustworthy answer to that claim comes
 * from under the lock. So a pinned enqueue may not conclude "no counterpart will ever exist" from any
 * unfenced read — not from the plugin flags, not from the sync toggles, not from the per-type posting
 * mode, not from a native-posting suppression rule.
 *
 * `refused` and `queued: true` answers are NOT in that class, and deliberately stay where they are:
 *
 *   * a `refused` before the fence leaves the obligation owed, which is what the fence would do on
 *     its worst day — it cannot settle anything, so it cannot settle anything wrongly;
 *   * `queued: true` from the idempotency short-circuit rests on A ROW THAT EXISTS, evidence about
 *     this posting rather than about the selection. Overriding it to `refused` would leave an
 *     obligation permanently unsettleable — the next attempt finds the same standing row — and r7
 *     established that a row on a retired connector is still claimable by the manual Sync button, so
 *     declining to count it would create the symmetric double-credit error.
 *
 * THE SHAPE, AND WHY THIS ONE. Two were available.
 *
 *   REJECTED — hoist every gate inside the inserting transaction, after the order lock and the fence,
 *   so there is no pre-transaction code left to return from. Strongest by construction, and it is
 *   what `queueAccountingSyncTx` already does (its fence is the first thing it takes, and its
 *   `not-configured` returns are all downstream of it). But the connector queues are the path EVERY
 *   unpinned enqueue in the system takes — order import, shipment confirmation, stock adjustment, the
 *   FX revaluation — and hoisting would make each of them open a transaction and take a sales-order
 *   ROW LOCK before it could discover that sync is switched off and that it will write nothing. New
 *   contention on order rows, for work that writes nothing, on the hot path. r8's safety argument was
 *   explicitly that unpinned traffic pays nothing for the fence; that must stay true.
 *
 *   CHOSEN — make the pre-fence region STRUCTURALLY UNABLE TO ANSWER. {@link connectorSyncGate} is a
 *   pure function whose return type is not a `ConnectorEnqueueOutcome`, so the settings gate cannot be
 *   returned from an enqueue however the call site is written, and
 *   {@link notConfiguredUnderPinnedLedgerFence} is the ONE conversion from that verdict to an outcome
 *   — and it asks the fence first. Neither connector queue names `not-configured` any more, which
 *   `tests/accounting/pinned-enqueue-fence.test.ts` asserts structurally, so a new unfenced gate
 *   cannot be added by copying the shape of an existing one.
 *
 * WHY THE ANSWER TAKES THE LOCK RATHER THAN RE-READING THE POOL. Nothing is written on this path, so
 * the lock is not being held across a write and does not need to be. It is taken for two properties a
 * pooled `getActiveAccountingConnectorId()` cannot supply:
 *
 *   * IT IS NOT TORN. A connector switch writes TWO rows, and the pooled resolver asks two separate
 *     questions (`isIntegrationPluginEnabled('xero')`, then `('quickbooks')`). Interleaved with a
 *     committing switch it can see neither flag set, or both. The locked read takes all six plugin
 *     rows in one `FOR UPDATE` statement, so it observes only whole, committed selections.
 *   * IT WAITS FOR AN IN-FLIGHT SWITCH instead of racing it. That is what makes a `not-configured`
 *     answer defensible: it names the committed configuration, with no switch part-applied behind it.
 *
 * LOCK ORDER. This path takes the plugin-selection lock AND NOTHING ELSE — no sales-order row lock, no
 * follow-up scope lock — because it writes nothing and so needs neither. A transaction that takes one
 * lock, uses it and ends cannot be half of a cycle, so it cannot invert the sales-order-row-lock ->
 * plugin-selection -> follow-up-scope order the writing paths take.
 */

import { pinnedLedgerIsServicedUnderLock, type AccountingConnectorSelection } from '@/lib/integration-plugin-selection-lock'
// Type-only, both of them: `lib/accounting` dynamically imports the connector queues that import
// this module, so a value import of the facade would close that loop. See the same note in
// lib/connectors/xero/queue.ts.
import type { ConnectorEnqueueOutcome } from '@/lib/accounting'

/** The ledgers a caller can pin a posting to. */
export type PinnableLedger = NonNullable<AccountingConnectorSelection>

/**
 * A CONNECTOR'S OWN SYNC VERDICT, IN A TYPE THAT IS NOT AN ENQUEUE OUTCOME.
 *
 * This is the whole structural point: `{ posts: false }` cannot be returned from `queueXeroSync` or
 * `queueQuickBooksSync`, so the gate that computes it cannot answer for a pinned enqueue even by
 * accident. The only way to turn it into an answer is
 * {@link notConfiguredUnderPinnedLedgerFence}, which consults the fence first.
 *
 * It also collapses what used to be TWO early returns per queue (`*_sync_enabled` off, and the
 * per-type posting mode off or absent) into one gate, so there is one hole to guard rather than four
 * across the two files.
 */
export type ConnectorSyncGate =
  | { readonly posts: false }
  | { readonly posts: true; readonly postingMode: string }

/**
 * `'true'` on the connector's master toggle AND a posting mode that is present and not `'off'`.
 *
 * Pure, and takes the two raw setting values rather than the settings object, so the same definition
 * serves both connectors without either one's settings type leaking into the other's.
 */
export function connectorSyncGate(
  syncEnabled: string | undefined,
  postingMode: string | undefined,
): ConnectorSyncGate {
  if (syncEnabled !== 'true') return { posts: false }
  if (!postingMode || postingMode === 'off') return { posts: false }
  return { posts: true, postingMode }
}

/**
 * THE ONE CONVERSION from "this connector does not post this" to an enqueue outcome.
 *
 * UNPINNED: `not-configured`, immediately, with no lock and no transaction. An unpinned enqueue took
 * its connector FROM the active-connector resolution, so there is no pin for a switch to invalidate
 * and nothing was ever fenced — the answer is about whichever ledger is active, which is what the
 * caller asked about. Every existing unpinned call site therefore pays exactly nothing, which is the
 * property that makes this safe to put on the hot path.
 *
 * PINNED: the fence decides. `not-configured` only if the pinned ledger is STILL the one being
 * serviced — then "no counterpart will ever exist" is a true statement about the ledger in use, and
 * settling the obligation on it is correct. Otherwise `refused`: the configuration that said "never"
 * has been retired, this queue is not entitled to speak for the ledger that replaced it, and the
 * posting stays owed.
 */
export async function notConfiguredUnderPinnedLedgerFence(
  pinnedLedger: PinnableLedger | undefined,
): Promise<ConnectorEnqueueOutcome> {
  if (!pinnedLedger) return { queued: false, reason: 'not-configured' }
  // Dynamically, so `@/lib/db` stays out of the static graph of every module that imports this one —
  // `lib/accounting.ts` deliberately keeps Prisma out of its own static imports and calls this. It
  // also means the unpinned path above does not even load the client.
  const { db } = await import('@/lib/db')
  const serviced = await db.$transaction((tx) => pinnedLedgerIsServicedUnderLock(tx, pinnedLedger))
  return serviced ? { queued: false, reason: 'not-configured' } : { queued: false, reason: 'refused' }
}
