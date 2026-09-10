/**
 * EVERY LEASE UNDER WHICH A WORKER MAY BELIEVE AN `IntegrationOutbox` ROW IS STILL ITS OWN
 * (o3d-8td2 round 4, Codex HIGH 1).
 *
 * A lease is written by exactly one statement in this build — the claim update in
 * `lib/domain/integrations/outbox.ts`, which stamps `lockedAt` — and read back by exactly one
 * predicate, `unlockedOrStale`. Every other writer of `status: PROCESSING`
 * (lib/connectors/xero/outbox.ts, the WooCommerce fold in stock-sync-jobs.ts) only ever narrows a
 * WHERE on a lock somebody else took; none of them stamps one. So the set of leases a row can be
 * under is the set of `staleLockMs` values passed to `claimIntegrationOutboxWork`, and that set is
 * THIS MAP.
 *
 * WHY IT IS A MAP AND NOT A NUMBER, AND WHY IT LIVES IN ITS OWN LEAF FILE. Round 3 wrote the
 * operator's staleness threshold as its own `10 * 60 * 1000`. It read as the same value as the
 * default lease — but `xero/accounting.post` is drained under FIFTEEN minutes, so the operator
 * surface called a Xero row stale five minutes before its holder's lease had even expired, and
 * offered an action on it. A restated constant cannot notice that; a MAXIMUM over a declared set
 * can, and {@link INTEGRATION_OUTBOX_MAX_LEASE_MS} is what `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS`
 * is derived from. Adding a longer lease here raises that threshold in the same edit.
 *
 * It is a leaf module for the same reason `outbox-replay-policy.ts` is: a DECLARATION every layer
 * reads — the claim, the admin threshold, the Xero drain — should not drag the outbox machinery in
 * behind it, and should not disappear when a test replaces that machinery with a double.
 *
 * `tests/domain/integrations/outbox.test.ts` asserts that no `staleLockMs:` argument anywhere in
 * `lib/` or `app/` is a number of its own, so a lease this file cannot see cannot be introduced.
 */
export const INTEGRATION_OUTBOX_DRAIN_LEASES_MS = {
  /** `claimIntegrationOutboxWork`'s own default: every drain that does not override it. */
  default: 10 * 60 * 1000,
  /** lib/connectors/xero/sync-processor.ts `CLAIM_STALE_MS` / `XERO_ENTRY_LEASE_MS`. */
  xeroAccountingEntry: 15 * 60 * 1000,
} as const

/** The longest any worker in this build can hold a row and still be within its lease. */
export const INTEGRATION_OUTBOX_MAX_LEASE_MS = Math.max(
  ...Object.values(INTEGRATION_OUTBOX_DRAIN_LEASES_MS),
)
