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

import type { Prisma } from '@/app/generated/prisma/client'
import { ACCOUNTING_CONNECTORS, type AccountingConnectorId } from '@/lib/connectors/accounting-registry'
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
 * o3d-j625 r13 — THE FENCE IS NOW ON EVERY ACCOUNTING ENQUEUE, SO "A REAL CLIENT CAN ALWAYS SERVE IT" HAS
 * TO BE CHECKED RATHER THAN ASSUMED.
 *
 * Until r13 the locked check ran only for a PINNED enqueue, and the handful of callers that pinned all
 * passed a Prisma transaction client. Making it unconditional puts it in front of EVERY in-transaction
 * enqueue, including ones whose caller hands over a narrowed alias — and a client without raw access would
 * turn a fence into a THROW inside somebody's business transaction. This is the same proof, and the same
 * shape, as `PrismaClientCanAlwaysReadTheSuppression` in posting-suppression.ts: checked by `tsc`, costing
 * nothing at runtime. If `Prisma.TransactionClient` ever stops satisfying it, this stops compiling here
 * instead of failing in a goods receipt.
 *
 * (Unit-test doubles are a different matter and are not covered by this: several had to learn to answer the
 * two statements, which is a fixture catching up with a question the subject now asks — not a client that
 * cannot answer it.)
 */
type AssertTrue<T extends true> = T
export type PrismaTransactionClientCanAlwaysBeFenced = AssertTrue<
  Prisma.TransactionClient extends PluginSelectionLockTx ? true : false
>

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
 * ACCOUNTING ACCOUNT-MAPPING KEYS, taken under the SAME lock as the plugin selection (o3d-8f0p6 r4).
 *
 * WHY THESE LIVE HERE RATHER THAN IN A LOCK OF THEIR OWN. Round 3 found that a posting which reads
 * an account code and then commits a journal has bound nothing unless the code cannot move in
 * between: re-reading under READ COMMITTED sees a remap that already committed, but holds nothing, so
 * a remap committing AFTER the re-read still lands a journal on stale codes — and, on an ASN spanning
 * several purchase orders, can put earlier POs on the old mapping and later ones on the new one
 * inside a single event. The answer is a lock held to COMMIT.
 *
 * It is THIS lock, not a second one, and that is the whole point. A separate mapping lock would add a
 * second acquisition over the `settings` table and a second order to reason about; the accounting
 * selection lock is already taken first by every writer that touches these rows' neighbours, is
 * already transactional (so already held to commit), and already has a canonical row order. Adding
 * keys to its row set costs one more entry in one `ORDER BY key` statement and no new ordering claim.
 *
 * LOCK ORDER, unchanged and now covering both key families: the advisory lock FIRST, then the rows in
 * one `ORDER BY key` statement. Both writers go through this module, so neither can invert it.
 *
 * WHO TAKES IT, exhaustively (checked 2026-09-27):
 *   · `saveXeroSettings` (app/actions/xero-sync.ts) — the ONLY writer of these two rows. They are not
 *     in `lib/domain/settings/writable-setting-keys.ts`, so `setSetting`/`setSettings` THROW on them
 *     rather than writing, and the other `xero_*` writers touch credentials, not the mapping.
 *   · the WMS book-in receipt path (lib/domain/wms/booked-in-service.ts), before it reads the codes.
 *   · `queueAccountingSyncTx`, via `pinnedLedgerIsServicedUnderLock`, for the plugin rows. It runs
 *     INSIDE the receipt transaction, which already holds this advisory lock by then, so its
 *     acquisition is a no-op re-entry rather than a second ordering.
 */
export const ACCOUNTING_MAPPING_SETTING_KEYS: Record<AccountingConnectorId, { inventory: string; transit: string }> = {
  xero: { inventory: 'xero_inventory_account', transit: 'xero_transit_account' },
}

/** The same keys, flat and sorted, for the lock statement. ONE definition, derived not copied. */
export function accountingMappingSettingKeys(connector: AccountingConnectorId): string[] {
  const keys = ACCOUNTING_MAPPING_SETTING_KEYS[connector]
  return [keys.inventory, keys.transit].sort()
}

/**
 * Acquire the selection lock over the plugin rows AND the named connector's account-mapping rows, and
 * hold both to COMMIT. Use this from any transaction that reads an account code and then posts with
 * it, and from any writer of those codes.
 *
 * Returns nothing: callers read the values they need afterwards, through the same `tx`, knowing no
 * writer can commit a change to them until this transaction ends.
 */
export async function lockAccountingMappingSelection(
  tx: PluginSelectionLockTx,
  connector: AccountingConnectorId,
): Promise<void> {
  const pluginKeys = [...INTEGRATION_PLUGIN_KEYS_IN_LOCK_ORDER]
  const mappingKeys = accountingMappingSettingKeys(connector)

  // FIRST, exactly as lockIntegrationPluginSelection does, and the SAME key: a lock acquired after
  // the read it protects protects nothing, and a DIFFERENT key here would be the second order this
  // design exists to avoid.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTING_CONNECTOR_SELECTION_LOCK_KEY})`

  // Materialise so the rows can be row-locked — but EACH FAMILY WITH ITS OWN ABSENT-VALUE MEANING.
  // A plugin row's absent value is 'false' (what lockIntegrationPluginSelection writes, and what
  // parseIntegrationPluginEnabled reads); a mapping row's is the empty string the account readers
  // fall back to. Materialising both as one literal would silently change what an absent plugin flag
  // says. Both are semantically inert for their own family.
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, 'false', now() FROM unnest(${pluginKeys}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`
  await tx.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    SELECT k, '', now() FROM unnest(${mappingKeys}::text[]) AS k
    ON CONFLICT (key) DO NOTHING`

  // ONE statement in ONE canonical order over both families, so the row-lock order is a property of
  // this statement rather than of the order the caller happened to list them in.
  await tx.$queryRaw`
    SELECT key FROM settings
    WHERE key = ANY(${[...pluginKeys, ...mappingKeys]}::text[])
    ORDER BY key
    FOR UPDATE`
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

/**
 * o3d-remove-parked-connectors: this was a THIRD hand-written spelling of the accounting id union
 * (`accounting-registry.ts` has the canonical one, `app/actions/accounting-sync.ts` and
 * `app/(dashboard)/sync/accounting-settings-fields.ts` had two more). Archiving QuickBooks was the
 * moment to stop copying it: it is now `AccountingConnectorId | null`, so registering a connector
 * widens this by construction instead of by somebody remembering this file.
 */
export type AccountingConnectorSelection = AccountingConnectorId | null

/**
 * First registered connector that is enabled, exactly like `getActiveConnector` — the same rule,
 * applied to a locked read instead of a pooled one. Kept as a pure function so the resolution rule
 * has ONE definition and can be asserted against the pooled path.
 */
export function resolveActiveAccountingConnector(
  state: Pick<IntegrationPluginState, AccountingConnectorId>,
): AccountingConnectorSelection {
  // REGISTRY ORDER, not a hand-written chain (o3d-remove-parked-connectors). This was
  // `if (state.xero) … if (state.quickbooks) …`, i.e. Xero-first by virtue of being written first.
  // It now walks ACCOUNTING_CONNECTORS in its declared order, so "the first enabled registered
  // connector wins" is the rule and the registry's order is where the precedence lives — the same
  // shape `resolveEnabledWmsConnector` uses. With one connector registered the two are
  // indistinguishable; with two they are not, which is why it is worth writing down now.
  for (const connector of ACCOUNTING_CONNECTORS) {
    if (state[connector.id]) return connector.id
  }
  return null
}

/**
 * o3d-i0o6 r8 (Codex round 7, HIGH) — THE PINNED-LEDGER CHECK, FENCED.
 *
 * Round 7 established the rule: a credit may be queued only to a ledger something still drains, so
 * a pinned enqueue whose connector is no longer the ACTIVE one refuses instead of writing. What it
 * enforced the rule with was an UNLOCKED snapshot — `getActiveAccountingConnectorId()` over the
 * pooled client — and then both enqueue paths awaited more work before their INSERT: the posting
 * context, the id-provenance read, the follow-up scope lock, the prior-attempt query. A connector
 * switch committing anywhere in that window put the row onto the now-inactive connector anyway, and
 * the orphan path then found that row and recorded its amount as posted relief, so every later
 * refund under-credits Allocated Inventory by it. The rule was right and its enforcement had a
 * window; this closes the window.
 *
 * ONE MECHANISM, NOT A SECOND ONE. This is `lockIntegrationPluginSelection` — the lock the
 * plugin-selection writers already take, the advisory key plus the `FOR UPDATE` row locks — applied
 * to the question the enqueue asks. Taken through the CALLER'S transaction, which is the whole
 * point: a transactional advisory lock and a row lock are held to COMMIT, so from the moment this
 * returns `true` until the transaction that asked ends, no writer can commit a change to the plugin
 * rows. The insert that follows is therefore inside the fence rather than after a check. A
 * compensating re-check afterwards was the alternative and is strictly worse: by then the row
 * exists, and nothing un-writes a queued credit.
 *
 * THE RULE IS `resolveActiveAccountingConnector`, the same Xero-first function
 * `cancelOrphanedAccountingSyncRows` resolves its own locked read through — so the fenced verdict
 * and the pooled one are the same rule over two sources, never two rules. The pooled form
 * (`pinnedLedgerIsServiced` in lib/accounting.ts) survives only as an EARLY refusal on the facade,
 * where it fixes the precedence of `refused` over `not-configured`; it decides nothing this does not
 * re-decide under the lock.
 *
 * LOCK ORDER: sales-order row lock FIRST, this SECOND, follow-up scope lock THIRD. Every enqueue
 * writer already took the order lock (hoisted by the caller for the in-transaction enqueue, taken by
 * `lockOrderForAccountingEnqueue` for the connector queues) before reaching here, and no
 * plugin-selection writer anywhere takes a sales-order lock at all — `resetDatabase` takes this lock
 * first inside its own transaction and never holds an order row — so no pair of transactions can take
 * these two in opposite orders.
 */
export async function pinnedLedgerIsServicedUnderLock(
  tx: PluginSelectionLockTx,
  connector: NonNullable<AccountingConnectorSelection>,
): Promise<boolean> {
  return resolveActiveAccountingConnector(await lockIntegrationPluginSelection(tx)) === connector
}
