/**
 * THE ONE WAY to read "which integration plugins are enabled" when you are about to DECIDE
 * something from the answer and then write (o3d-osl8 round 6, findings 1 and 2).
 *
 * It does three things, in this order, and the order is the whole point:
 *
 *   1. Takes ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY, which serializes every writer that takes it.
 *   2. MATERIALISES the plugin setting rows (`ON CONFLICT DO NOTHING` at their already-effective
 *      default, `false` — an absent row and `false` mean the same thing to `parseIntegrationPluginEnabled`).
 *   3. Row-locks them `FOR UPDATE` and returns the state read from the locked rows.
 *
 * WHY 2 AND 3, when 1 exists. The advisory lock binds only writers that TAKE it, and the writers
 * that do not are not hypothetical: the full-chain quiesce harness writes `plugin_xero_enabled`
 * with raw SQL over a `pg` client, the e2e fixture scripts upsert it through Prisma directly, and
 * `resetDatabase` deletes every settings row. A checker holding only the advisory lock therefore
 * has an UNFENCED window between its last verification and its commit, in which any of those can
 * commit a selection change — and for `cancelOrphanedAccountingSyncRows` that window is the
 * difference between retiring a dead queue and retiring the live one.
 *
 * `FOR UPDATE` closes that window for EVERY writer, because it is Postgres, not a convention:
 * while this transaction is open, no other transaction can commit an UPDATE or DELETE of these
 * rows. Step 2 exists because `FOR UPDATE` locks only rows that EXIST — a missing
 * `plugin_quickbooks_enabled` could otherwise be INSERTed by a bypassing writer mid-transaction,
 * which is precisely the "both connectors enabled" and "connector switched under the sweep"
 * transitions this is guarding. Materialising first makes the rows lockable, and is idempotent and
 * semantically inert.
 *
 * LOCK ORDER, so this cannot deadlock. Every caller goes through this function, so every caller
 * takes the advisory lock FIRST and the setting rows SECOND, in one canonical key order
 * (`ORDER BY key`). No path anywhere takes a settings row lock and then this advisory lock — that
 * inversion is the only way these could cycle. Checked against every other lock in
 * lib/db/advisory-locks.ts: none of them is held across a plugin-key write, and the rows locked
 * here (`plugin_*`) are disjoint from the settings keys the refund, sweep and poller transactions
 * touch, so no cross-domain cycle exists either.
 *
 * NOT USED by the ordinary read path. `getIntegrationPluginState()` stays lock-free: a reader that
 * only renders the answer does not need to stop the world, and making every page render take a
 * row lock would be a real cost for no correctness gain.
 */

import { ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import {
  INTEGRATION_PLUGIN_IDS,
  INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER,
  INTEGRATION_PLUGIN_SETTING_KEYS,
  parseIntegrationPluginEnabled,
  type IntegrationPluginState,
} from '@/lib/integration-plugin-keys'

/** The subset of a Prisma transaction client this needs. Structural, so a test can supply it. */
export type PluginSelectionLockTx = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/**
 * Acquire the selection lock and read the plugin state through the transaction.
 *
 * The returned state is stable for the rest of the transaction: nothing outside it can commit a
 * change to these rows until it ends.
 */
export async function lockIntegrationPluginSelection(
  tx: PluginSelectionLockTx,
): Promise<IntegrationPluginState> {
  const keys = [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER]

  // FIRST, before anything is read: a lock acquired after the read it is meant to protect protects
  // nothing.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`

  // Make the rows exist so they can be row-locked. `false` is what an absent row already means.
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, 'false', now() FROM unnest(${keys}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`

  return readLockedPluginSelection(tx)
}

/**
 * Re-read the selection from the already-locked rows.
 *
 * For the fence in cancelOrphanedAccountingSyncRows, which verifies just before commit. Re-issuing
 * `FOR UPDATE` on rows this transaction already holds is a no-op in Postgres, and issuing it
 * rather than a plain SELECT is deliberate: if this is ever reached WITHOUT
 * lockIntegrationPluginSelection having run, the read still takes the lock rather than silently
 * reading unfenced.
 *
 * Under READ COMMITTED this statement takes a fresh snapshot, so it would observe a change that
 * had managed to commit — which is exactly what makes it a usable assertion that none can.
 */
export async function readLockedPluginSelection(
  tx: PluginSelectionLockTx,
): Promise<IntegrationPluginState> {
  const keys = [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER]
  const rows = await tx.$queryRaw<Array<{ key: string; value: string }>>`
    SELECT key, value FROM settings
    WHERE key = ANY(${keys}::text[])
    ORDER BY key
    FOR UPDATE`

  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  return Object.fromEntries(
    INTEGRATION_PLUGIN_IDS.map((id) => [id, parseIntegrationPluginEnabled(byKey.get(INTEGRATION_PLUGIN_SETTING_KEYS[id]))]),
  ) as IntegrationPluginState
}

export type AccountingConnectorSelection = 'xero' | 'quickbooks' | null

/**
 * Xero-first, exactly like `getActiveConnector` — the same rule, applied to a locked read instead
 * of a pooled one. Kept as a pure function so the resolution rule has ONE definition and can be
 * asserted against the pooled path.
 */
export function resolveActiveAccountingConnector(
  state: Pick<IntegrationPluginState, 'xero' | 'quickbooks'>,
): AccountingConnectorSelection {
  if (state.xero) return 'xero'
  if (state.quickbooks) return 'quickbooks'
  return null
}
