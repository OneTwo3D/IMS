# Archived: the QuickBooks Online accounting connector

**Removed on branch `o3d-remove-parked-connectors`.**
**Last commit in which the connector was part of the ACTIVE tree:
`530229e69f17490da5fa3cd4340c587845931638`** (`development`, 2026-09-24, "Guard every concurrency
test file with the scratch-database check, at import (o3d-yvn8)" #696).
**Annotated tag: `archive/quickbooks-connector`** — points at that commit.
**The connector's own source is still in the tree**, at
[`archive/connectors/quickbooks/`](../../archive/connectors/quickbooks/) — not built, not
type-checked, not linted, not tested. See
[`archive/connectors/README.md`](../../archive/connectors/README.md).

The owner's decision (verbatim, 2026-09): *"also remove the QuickBooks, Shopify and Shiphero
connectors from the active codebase (archive the code but remove it from active installs). but keep
the generic design of the ims so it is possible to add later on different connectors."* Active
connectors are WooCommerce, Mintsoft and Xero (connector priority 2026-08).

[`connector-removal-plan.md`](./connector-removal-plan.md) surveyed this removal in detail and recommended doing it
**after** the in-flight accounting branches merged. It was done now on an explicit instruction, so
expect rebase conflicts on any accounting branch that is still open — `lib/accounting.ts`,
`lib/connectors/accounting-registry.ts`, `lib/connectors/accounting-settlement-probe.ts` and the
`tests/accounting/**` suite are the collision surface.

---

## What moved to `archive/connectors/quickbooks/`

| Original path | What it was |
| --- | --- |
| `lib/connectors/quickbooks/**` (17 files, ~5,400 LOC) | REST client, OAuth (realm binding, token refresh, revoke), accounts + tax codes, contacts, items, invoices, credit notes, bills, journals, FX, invoice PDF, queue, settings, daily-batch sync, payment poller, the sync processor |
| `app/actions/quickbooks-sync.ts`, `app/actions/quickbooks-daily-batch.ts` | Its two server-action modules |
| `tests/**/{quickbooks,qbo}-*.test.ts` (15 files) | Its own unit tests |
| `tests/accounting/shared-reversal-classifier.test.ts` | 28 cases, 1,135 lines — see "What is no longer proven", item 1 |
| `docs/todo/quickbooks-tax-parity-plan.md` | Its follow-up plan, now closed-not-done |

## What was removed from the generic layer

- `AccountingConnectorId` is a union of one; the `quickbooks` entry left `ACCOUNTING_CONNECTORS`.
- `NON_WMS_INTEGRATION_PLUGIN_IDS` lost `quickbooks`, so `plugin_quickbooks_enabled` is no longer a
  key this build writes, reads, locks or offers a switch for.
- **The `accounting` exclusivity group is deleted, not shrunk** — Xero's only partner was QuickBooks,
  and a one-member group reads as an enforced rule while enforcing nothing. Shopify's removal had
  already taken the `shopping` group; `wms` is the only group left, and its ids are derived.
- ~410 lines of `accounting-settlement-probe.ts` (`probeQuickBooksSettlement`, the three link-type
  sets, `qboAmountAppliedTo`, the QBO document types) and the now-callerless `num()` helper.
- The QuickBooks branches of `app/api/cron/accounting-{sync,payment-poll,payment-reconcile,daily-batch}`
  and of `app/api/accounting/callback`.
- The `/sync` card, logo, deep link and panel entry; the onboarding switch, credential form and save
  handler; the `quickbooks_*` reads in `lib/accounting.ts` (settings, accounts, bank accounts,
  balance snapshots, the sync-type setting map, the queue arm).
- `autoLinkQuickBooksTaxRates`, `previewMissingQuickBooksTaxRates`, `generateMissingQuickBooksTaxRates`.
- Env: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_COMPANY_ID` from `.env.example`,
  `scripts/provision-ims-tenant.env.example` and the documented-env-var allowlist (that file fails on
  a stale entry).
- Five entries in `lib/analytics/refund-figure-surfaces.ts` and one in
  `scripts/check-fulfillment-requirement-seam.mjs`; the `lib/connectors/quickbooks` target in
  `scripts/decimal-boundary-targets.json`. All three configs FAIL on a stale entry, which is what
  found them.

## The abstraction was FIXED on the way out, not just narrowed

The removal plan's own finding was that the accounting abstraction was shaped around the *weaker*
connector. Six duplicate spellings of one id union, and a factory that was an `if` with one arm.
Rather than leave a bare `return xero()` behind, this branch:

1. **`getAccountingConnector` is a keyed factory.** It was
   `if (id === 'quickbooks') { …45 methods… }` falling through to Xero. It is now a mapped type
   `{ [Id in AccountingConnectorId]: (def: AccountingConnectorDef & { id: Id }) => AccountingConnector }`
   — total over the union, and the builder's parameter mentions the KEY, not the union, so an entry
   cannot be filed under one id and return another (the ShipHero round-14 finding, applied here).
2. **Six duplicate id unions collapsed into the registry's one**: `accounting-registry.ts` (canonical),
   `app/actions/accounting-sync.ts`, `app/(dashboard)/sync/accounting-settings-fields.ts`,
   `lib/domain/accounting/connector-orphans.ts`, `lib/integration-plugin-selection-lock.ts` and
   `app/(dashboard)/sync/accounting-connector-panel.tsx` now alias or re-export it.
3. **"Which connector is active" is one rule, walked from the registry, in all four places that ask
   it** — `getActiveAccountingConnectorId` (pooled), `resolveActiveAccountingConnector` (locked),
   `getActiveConnector` (server action) and the two `'use server'` copies in
   `accounting-settlement.ts` / `accounting-stranded-rows.ts`. Each was a hand-written `if` chain
   naming two connectors; each now walks `ACCOUNTING_CONNECTORS` in its declared order, so the
   precedence lives in the registry.
4. **`isRegisteredAccountingConnector` replaces four literal-pair membership tests.** The `connector`
   columns are plain `String`, so a stored row can name an archived connector; the old tests
   (`=== 'xero' || === 'quickbooks'`) would have gone on ACCEPTING `quickbooks` after the code to
   service it was gone.
5. **Labels come from the registry.** `connector === 'xero' ? 'Xero' : 'QuickBooks'` appeared three
   times and labelled every unrecognised connector as the other one.
6. **The `/sync` accounting panel map is total over the id union**, and its membership predicate is
   derived from the map rather than from a literal pair.
7. **The OAuth callback no longer discriminates on `realmId`** — a caller-controlled query parameter.
   With one connector there is nothing to discriminate; the test that pinned the old behaviour is
   replaced by one asserting a supplied `realmId` CANNOT steer the route.

**Not done, and deliberately:** the removal plan also proposed giving `AccountingConnectorDef`
capability flags (connection-test gate, balance-snapshot ingestion, attempt-revision stamping,
settlement probe, payment reconcile) and restoring `attemptRevision` to `AccountingSyncLogRow`. The
capability flags have nothing left to distinguish — every stub they were to replace was a QuickBooks
stub and is gone — so adding them now would be five fields with one value each and no test able to
tell them apart. `expectedAttemptRevision` is left OPTIONAL because the reason given in the interface
(the bulk "Retry All" form is not a decision about any particular attempt) is not a QuickBooks reason.
Both are filed as follow-ups rather than guessed at.

## What was KEPT, and why

- **`accounting-id-provenance.ts`** is not a two-connector artefact. Its string is
  `"<connector>:<tenantId>"` and the TENANT half stays load-bearing with one connector — a
  re-authorisation to a different Xero org is exactly what it exists for. The `<connector>:` prefix is
  embedded in stored data (`Product.accountingItemProvenance`, `Customer`/`Supplier.
  accountingContactProvenance`, `AccountingSyncLog.connectionProvenance`), so it could not be dropped
  without a migration, and there is no reason to. The same is true of
  `accounting-connection-provenance.ts` (motivated by a pure-Xero incident, o3d-t74p),
  `accounting-egress-authorization.ts` and `accounting-binding-lock-order.ts`.
- **`quickbooks_expected_realm_id` in `ACCOUNTING_BINDING_PIN_SETTING_KEYS`.** No code writes that row
  any more, but a development database that ran QuickBooks HOLDS it, and this list is what a wholesale
  settings delete excludes so it cannot take the row in scan order and deadlock against the pin
  trigger. A retired key in an exclusion list costs nothing; removing it reopens the cycle.
- **`quickbooks_client_secret` in `SENSITIVE_SETTING_KEYS`.** Same reasoning, and it fails safe: a
  stale sensitive key over-protects.
- **`ACCOUNTING_FOLLOW_UP_RECOVERY['quickbooks']`, `sync-row-claimability`'s `quickbooks` entry,
  `connector-orphans`, and the `CONNECTOR_LABELS` maps in the orphan and failed-sync banners.** These
  are all keyed by the STORED connector string, and stored `quickbooks` rows exist. Removing them
  would make an existing row render as an unlabelled id, or drop out of a summary that is the only
  way an operator can see and cancel it. `connector-orphans` in particular is now UNREACHABLE by a
  connector switch — there is no switch — and its only population is rows naming an archived
  connector, which is precisely the state a development database is in.
- **The `quickbooks` branch in `effectiveTokenFor`** (`followup-retry-guard.ts`), unreachable and
  written as `(connector as string) === 'quickbooks'`. It encodes a per-connector rule — QuickBooks
  honoured the generic queue's `_idempotencyKey`, Xero's payment branches ignore it — and folding the
  two together would apply one connector's reading to the other and could ALLOW an unsafe retry.
- **The `OPERATOR_ASSERTION` settlement surface**, which exists largely because QuickBooks had no
  reconcile sweep. It is a general "a human typed the outcome and IMS verified nothing" distinction,
  and the sync page still renders it; a second connector without a reconcile sweep needs it on day one.
- **`WEBHOOK_ORIGIN_NOT_APPLICABLE`, string-typed money (`number | string`) in
  `readLedgerStatedAmount`, and the completeness band.** All three were introduced for QuickBooks'
  wire behaviour and all three are general robustness. They stay; what changes is that the connector
  that motivated them is no longer there to demonstrate them (see below).

## What is no longer proven

This is the honest cost. Each item is a place where a test that used to distinguish "generic" from
"Xero with extra steps" can no longer do so.

1. **`tests/accounting/shared-reversal-classifier.test.ts` is archived whole** (28 cases). Its subject
   was the SHARED reversal classifier driven through BOTH connectors' readers, and the QuickBooks
   reader (`qboLedgerAmount`, `qboWithheldReversalReason`, `resolveLedgerRowCurrency`) went with the
   connector. Its own header states why the second column existed: "QuickBooks' reversal read
   enumerates no payments at all, so its listing is always NULL — and null is 'absence cannot be
   established', never 'no payments'." Nothing now exercises the classifier against a connector that
   cannot enumerate. **This is the biggest single loss.**
2. **`tests/accounting/daily-batch-recreate-pass-share.test.ts` lost its whole cross-ledger section**
   (9 cases and the fixture that ran BOTH writers). The rules are still in
   `recreateMissingDailyBatchLogs` — a live-log probe filtered by `connector`, a per-ledger share from
   the pass history, and a report for a foreign share nobody is scheduled to rebuild — and they are
   now UNTESTED. With `quickbooks`-stamped rows surviving in development databases, that reporting
   path is what an operator will actually meet.
3. **`tests/accounting/followup-obligation-writers.test.ts` lost 28 cases** — the entire o3d-peh1 /
   o3d-qn21 / o3d-0bfh r5 block, which ran on QuickBooks *because* its catch treated every follow-up
   exception as best-effort and fell through to `succeeded++`. None of those properties is
   Xero-specific; a follow-up asks for them to be re-established against the Xero processor.
4. **`tests/accounting/daily-batch-recreate-persisted-ref.test.ts` lost 14 cases** — the twin of every
   Xero case. Their own comment is the reason they existed: "a refusal that exists on one connector
   and not the other is how the two sweeps drift back apart."
5. **`tests/security/accounting-read-authorization.test.ts` lost its second connector.** It asserted
   the same EXECUTED RBAC proof on two connectors' reads; it now asserts it on one.
6. **`tests/accounting/settlement-probe*.test.ts` lost their QuickBooks arms** (14 + 17 + 2 cases),
   including the cases whose whole point was "all THREE arms read a string figure" and "the rule is
   ONE function, and all three arms reach it". The rules (o3d-obyd string money, o3d-mm51 difference
   bound, o3d-r948 completeness band) are still asserted — through the Xero arms only.
7. **The exclusivity-refusal cases moved out of
   `tests/accounting/plugin-selection-lock.test.ts`.** Every refusal in that file came from the
   `accounting` group. The SAME properties — a refusal stores nothing, two concurrent partial writes
   cannot assemble an illegal state, the onboarding writer applies the same ruleset — are asserted in
   `tests/wms-single-connector-exclusivity.test.ts` against the `wms` group with a REGISTERED
   fictitious connector (`acme-wms`), which is a stronger home for them. What is genuinely gone is
   coverage of a HAND-WRITTEN group.
8. **`resolveActiveAccountingConnector`'s PRECEDENCE is unobservable.** With one registered connector
   the state space is two states, and a hardcoded `state.xero ? 'xero' : null` passes every assertion.
   The tests now assert what can still be asserted — totality over the registry, `null` for nothing
   enabled, and that the walk follows the registry's order — and say so.
9. **The pinned-ledger fence has no ALLOWED direction for a non-Xero pin.** The refusal is still
   driven (with an id the union does not contain, which is also what a stored row can hold), but the
   control that made it a narrowing rather than a blanket needed a second queue.
10. **Four cross-port loops are now one-armed**: the A1 staleness fence, the manual-retry action's
    guard-consultation shape, the connector-disconnect id-clearing rule, and the `not-configured`
    structural check over connector queues. Each keeps its loop shape so a second connector inherits
    every case — and each is a place where "two independently-written implementations satisfy this"
    has become "one does".
11. **Several tests now drive an UNREGISTERED id** rather than a second registered connector:
    `fx-journal-suppression` (that the suppression is keyed by connector at all), `manual-retry-guard`
    (that the token derivation is per connector), `pinned-ledger-fence`, `money-post-authorisation`,
    `accounting-settings-fields` (that the payload prefix comes from the argument, not a hardcode),
    and the refund cross-ledger refusals. Every one of them is commented at the site. They lock a real
    property and they are a weaker subject.

## Database and data (development only; production is unused and will be reinstalled)

**No migration was authored and no database is altered by this branch.** There is no
`AccountingConnector` enum and no QuickBooks-specific model or column: the connector is a plain
`String @default("xero")` on `AccountingAccount`, `AccountingAccountBalanceSnapshot`,
`AccountingSyncLog` and `AccountingToken`.

Decisions, stated rather than left implicit:

- **`AccountingSyncLog` rows with `connector = 'quickbooks'`: LEAVE THEM.** They are financial
  evidence — what IMS believes it posted, and where. Nothing claims them (each processor filters on
  its own connector), and `getCrossConnectorOrphanSummary` is exactly the surface that makes them
  visible and bulk-cancellable. The settle-one-row action now refuses them explicitly ("that sync
  entry no longer exists") rather than trying to read a ledger it cannot reach.
- **`AccountingToken` / `AccountingAccount` / `AccountingAccountBalanceSnapshot` rows with
  `connector = 'quickbooks'`: LEAVE THEM.** A token row is a credential and deleting it is a remote
  side effect nobody asked for; the other two are a cache.
- **`Setting` rows `quickbooks_*` and `plugin_quickbooks_enabled`: LEAVE THEM.** Nothing reads them —
  `getIntegrationPluginState` is built over the id union, so it cannot see the plugin flag at all —
  and `quickbooks_expected_realm_id` is still in the wholesale-delete exclusion list for the deadlock
  reason above.
- **Provenance strings beginning `quickbooks:`** on `Product.accountingItemProvenance` and the two
  contact-provenance columns: LEAVE THEM. They are read as opaque namespaces, and a row from a
  namespace this build cannot issue is inert, which is what the provenance design is for.

`DELETE FROM settings WHERE key LIKE 'quickbooks\_%'` is safe on a database that will never run
QuickBooks again and needs no code change — but it is not something this branch does on anyone's
behalf.

## o3d-c08y: the QuickBooks Group B negative-basis HIGH

Codex blocked `o3d-c08y` on a HIGH: **QuickBooks' daily-batch Group B had no negative-basis refusal,
so a negative cost basis silently dropped its COGS pair and stamped the shipment.** The Xero refusals
shipped in #691; the QuickBooks half was outstanding.

`lib/connectors/quickbooks/daily-sync.ts` — the file that held that Group B — is archived and no
longer reachable: `app/api/cron/accounting-daily-batch` resolves its sweep through
`resolveScheduledDailyBatchSweep`, whose `DAILY_BATCH_SWEEPS` list now has one entry, and the route's
dispatch is an exhaustive `switch` over `DailyBatchSweepConnector` with a single `case 'xero'`. There
is no path from any cron, any server action or any operator control to a QuickBooks Group B in this
build. **The HIGH is moot on this branch's head.** It is not "fixed" — the refusal was never written —
so if QuickBooks is ever revived from the archive, it comes back with that defect intact, and the
revival note says so.
