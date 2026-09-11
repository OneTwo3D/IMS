/**
 * EVERY LEASE UNDER WHICH A WORKER MAY BELIEVE AN `IntegrationOutbox` ROW IS STILL ITS OWN
 * (o3d-8td2 round 4, Codex HIGH 1; re-stated round 6 when the operator action was withdrawn).
 *
 * A lease is written by exactly one statement in this build — the claim update in
 * `lib/domain/integrations/outbox.ts`, which stamps `lockedAt` — and read back by exactly one
 * predicate, `unlockedOrStale`. Every other writer of `status: PROCESSING`
 * (lib/connectors/xero/outbox.ts, the WooCommerce fold in stock-sync-jobs.ts) only ever narrows a
 * WHERE on a lock somebody else took; none of them stamps one. So the set of leases a row can be
 * under is the set of `staleLockMs` values passed to `claimIntegrationOutboxWork`, and that set is
 * THIS MAP.
 *
 * WHAT IT PAYS FOR, SAID AGAIN BECAUSE THE REASON HAS NOW CHANGED TWICE. Round 4 derived an operator
 * ACTION's threshold from this map; round 6 withdrew that action; round 7 left the LIST it sat on;
 * round 8 withdrew the list as well (o3d-7qdb). The map outlives all three, because its two real
 * consumers were never the park:
 *
 *   1. THE CLAIM ITSELF. `ClaimIntegrationOutboxOptions.staleLockMs` is typed as
 *      {@link IntegrationOutboxDrainLeaseMs}, the literal union of this map's values, so a drain
 *      cannot take a lease this file has not declared — see the enforcement note below. That is a
 *      property of the claim path and has nothing to do with any operator surface.
 *   2. THE DEAD-LETTER GATE, which predates this branch.
 *      `permanentlyFailIntegrationOutboxAdminRow` refuses a PROCESSING row whose lock is younger
 *      than `ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS`, and on `development` that constant is its own
 *      restated `10 * 60 * 1000` — SHORTER than the fifteen minutes `xero/accounting.post` is
 *      actually drained under, so between minute 10 and minute 15 an admin could bury a live Xero
 *      claim (o3d-zdvn). A restated constant cannot notice that; a MAXIMUM over a declared set can,
 *      and {@link INTEGRATION_OUTBOX_MAX_LEASE_MS} is what that threshold is derived from. Adding a
 *      longer lease here raises the gate in the same edit.
 *
 * It is a leaf module for the same reason `outbox-replay-policy.ts` is: a DECLARATION every layer
 * reads — the claim, the admin threshold, the Xero drain — should not drag the outbox machinery in
 * behind it, and should not disappear when a test replaces that machinery with a double.
 *
 * HOW EXHAUSTIVENESS IS ENFORCED, AND WHY IT IS NOT A TEST (o3d-8td2 round 6, Codex MEDIUM). Rounds
 * 4 and 5 policed this with a regex over `lib/` and `app/` looking for `staleLockMs:`. Codex was
 * right that it was porous — `{ staleLockMs }` shorthand, a spread, and any arithmetic merely
 * CONTAINING the map's name all walked past it — and a cleverer pattern would only move the hole,
 * because "what value reaches this parameter" is a question about a program and not about a string.
 * So it is asked of the compiler instead: {@link IntegrationOutboxDrainLeaseMs} is the literal union
 * of this map's values, and `ClaimIntegrationOutboxOptions.staleLockMs` has that type. Shorthand,
 * spreads and computed arguments are all checked, because assignability is checked at every call
 * site whatever its syntax, and `INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default * 2` is `number`, which
 * is not assignable to `600000 | 900000`. A lease this file cannot see is a TYPE ERROR, not a test
 * failure — and `tests/domain/integrations/outbox.test.ts` proves the union has not silently widened
 * to `number` with `@ts-expect-error` fixtures, which fail the build if they ever stop erroring.
 */
/**
 * WRITTEN AS BARE LITERALS ON PURPOSE, and the reason is the type below rather than taste. Under
 * `as const` TypeScript keeps a LITERAL type only for a literal; `10 * 60 * 1000` is an arithmetic
 * expression and comes back as plain `number`, which collapses
 * {@link IntegrationOutboxDrainLeaseMs} to `number` and makes the whole guard accept anything. That
 * is not a hypothetical: the round-6 first draft wrote it that way, every `@ts-expect-error` fixture
 * in the test went unused, and `tsc` failed the build for it — which is the guard's own guard
 * working. `tests/domain/integrations/outbox.test.ts` asserts these numbers are the minutes the
 * comments claim, so the readability the arithmetic used to carry is checked rather than lost.
 */
export const INTEGRATION_OUTBOX_DRAIN_LEASES_MS = {
  /** Ten minutes: `claimIntegrationOutboxWork`'s own default, for every drain that does not override it. */
  default: 600_000,
  /** Fifteen minutes: lib/connectors/xero/sync-processor.ts `CLAIM_STALE_MS` / `XERO_ENTRY_LEASE_MS`. */
  xeroAccountingEntry: 900_000,
} as const

/**
 * THE ONLY LEASES A CLAIM MAY TAKE — the literal union of the map above, and the type
 * `claimIntegrationOutboxWork` accepts.
 *
 * A drain that needs a lease not listed here adds it to the map, in the same edit that raises the
 * listing threshold derived from the maximum. That is the whole mechanism; there is no way to pass a
 * lease around it, because there is no way to produce a value of this type that the map does not
 * contain.
 */
export type IntegrationOutboxDrainLeaseMs =
  (typeof INTEGRATION_OUTBOX_DRAIN_LEASES_MS)[keyof typeof INTEGRATION_OUTBOX_DRAIN_LEASES_MS]

/** The longest any worker in this build can hold a row and still be within its lease. */
export const INTEGRATION_OUTBOX_MAX_LEASE_MS = Math.max(
  ...Object.values(INTEGRATION_OUTBOX_DRAIN_LEASES_MS),
)
