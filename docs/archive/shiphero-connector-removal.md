# Archived: the ShipHero WMS connector

**Removed on branch `o3d-remove-shiphero`.**
**Last commit that contains the connector: `bee0db44b4e749ddc652bf265d74bd14fcc5d5b9`**
(`development`, 2026-09-10, "Declare what a stale-lock reclaim may replay …" #674).
**Annotated tag: `archive/shiphero-connector`** — points at that commit.

The owner's decision was that ShipHero, Shopify and QuickBooks are out of focus.
ShipHero had no live deployment; the repository was the deploy. Nothing was
migrated and no production rows were touched.

---

## Why a tag and a note, and not a retained branch or a feature flag

Git already has everything, so "archive" is only about **discoverability** — can
somebody who has never heard of ShipHero find the code in five years?

- **Not a feature flag.** Dead code behind a flag is not archived, it is
  unmaintained: it compiles, so it survives refactors by being mechanically
  updated by people who never run it, and it drifts into something that has
  never worked. The whole point of removing a connector is that nobody is
  maintaining it.
- **Not a retained branch.** A branch is a *moving* ref that looks like live
  work: it shows up in `git branch -a`, invites "should we merge this?", and
  goes stale silently. It also implies somebody is minding it.
- **An annotated tag** is immutable, is fetched by default, is listed by
  `git tag -l 'archive/*'`, and carries its own message explaining what it marks.
  It is the cheapest thing that answers "which commit still has it?" without
  implying anyone is looking after it.
- **This note** is the discoverable half. A tag only helps someone who already
  suspects ShipHero existed. A file in `docs/archive/` is what a grep for
  "shiphero" in the working tree still finds after the code is gone, and it is
  what the code comments now point at.

**Recovering the connector:**

```bash
git show archive/shiphero-connector:lib/connectors/shiphero/index.ts
git checkout archive/shiphero-connector -- lib/connectors/shiphero
```

---

## What was removed

**The connector and its ingress** (deleted outright):

| Path | What it was |
| --- | --- |
| `lib/connectors/shiphero/**` (15 files) | GraphQL client, OAuth token lifecycle, order status/push/cancel/comment, stock sync, webhook events + signature validation, settings schema |
| `lib/cron-jobs/wms-shiphero.ts` | Registration of the three ShipHero cron jobs |
| `lib/jobs/wms/process-shiphero-webhook-event.ts` | Webhook staging/dedupe/monotonic-rank writeback job |
| `app/api/cron/shiphero-{reconcile,stock-sync,webhook-sweeper}` | The cron endpoints |
| `app/api/webhooks/shiphero/[event]` | The public webhook ingress |
| `tests/shiphero-*.test.ts` (6 files) | Its unit tests |

**Registrations removed:** the `shiphero` entry in `WMS_CONNECTOR_IDS`, the WMS
registry, `IntegrationPluginId` + `plugin_shiphero_enabled`, the
`shiphero_access_token` / `shiphero_refresh_token` / `shiphero_webhook_secret`
settings-store secrets, the route-auth and public-route security policy entries,
and the ShipHero paths in the WMS connector-boundary allowlist.

**Dead-on-removal generic code, also deleted:**
`lib/domain/wms/stock-sync-helpers.ts` lost everything except
`classifyUnresolvedWmsSku`. That module was created as a "connector-agnostic"
mirror of Mintsoft's connector-local helpers so the ShipHero stock sync had
something generic to call — but Mintsoft was never migrated onto it, so what
shipped was a second **copy**, not a shared module. Threshold parsing, line
consolidation, binding-due timing and discrepancy computation each existed twice
and lost their only caller here. That is the abstraction being shaped around one
implementation, and it is worth knowing before the next removal.

## What was kept, and why

- **`WmsWebhookEvent` / `wms_webhook_events`.** Genuinely generic push-primary
  webhook staging: a `connector` column, idempotent dedupe on
  `(connector, externalEventId)`, retry/dead-letter state and a monotonic status
  rank. Its readers are shared multi-source aggregators (the sync-exception
  dead-letter inbox, `lib/data-retention.ts`), not a ShipHero code path.
  **No connector writes to it today** — that is stated in the schema comment
  rather than hidden. It is empty-by-design infrastructure, not dead code:
  nothing branches on whether it has rows. If no push-primary connector has
  landed by the time the Shopify and QuickBooks removals are done, drop it then.
  **No migration was authored**, so no database is altered by this branch.
- **`WmsInboundReceiptEvent`** — Mintsoft's ASN poll model. Untouched.
- **The `client-side-dedupe-only` create-replay policy value.** ShipHero was its
  only holder, but it is a real property of real 3PL APIs and every refusal path
  in the push sweep, the held-release rule and the exception inbox is built on
  it. It is now exercised by a registered fictitious connector — see below.
- **The registries.** `lib/connectors/wms/{registry,active-connector,types,asn-types,order-lookup,errors}.ts`
  all stay, reshaped so a second connector is a registration rather than an edit.

## How the abstraction is protected now

Two test files, and they cover different halves of the same claim.

**`tests/wms-second-connector-seam.test.ts`** registers a **fictitious** WMS
connector (`acme-wms`, `tests/helpers/fictitious-wms-connector.ts`) — a complete
in-memory warehouse written only against the `WmsConnector` contract — and drives
the generic layer through it: registry construction, create-replay policy and
every refusal that turns on it, the held-release rule, the exception inbox's
replay affordance, `WmsUnresolvableRecordError` → UNRESOLVED mapping inside the
real dispatch sweep, per-order reconciliation for a WMS with no bulk delta, ASN
label decoration, the WMS→shopping order-lookup resolver, and the
push-verification contract.

**`tests/wms-second-connector-seam-production.test.ts`** (added in round 2) does
the thing the file above cannot: it starts at the **outside**. It registers
`acme-wms`, makes it the active connector, and calls the real
`app/actions/wms-asn.ts`, `app/actions/wms-sync.ts` and
`app/actions/wms-onboarding.ts` server actions, the real product-sync dispatcher,
and — since round 4 — the real `runWmsDispatchSweep` **wrapper** rather than its
core. Round 2's version called the core and handed it `deltaTimeZone: 'UTC'`, so
the value production *derives* was supplied by the test and the derivation was the
one thing the test could not see; that is how the timezone default survived.

**Why the second file had to exist.** Codex's round-1 review found that every
test in the first file began *inside* the generic layer — handing the fictitious
connector to a decorator, a policy function or the sweep core directly. Behaving
generically when you are handed a second connector is not the same as being
*reached* with one, and the defects were all on the path in between: the ASN
facade dispatched on `connector === 'mintsoft'`, and the dispatch sweep wired
every connector's delta cursors to Mintsoft's setting rows. Both were invisible
to a test that started past them. That is the proof-of-an-adjacent-property
shape — sound, and about the wrong thing.

Supporting changes that made that possible, and that are the seam itself:

- `WmsConnector` is generic over its id, so a connector can exist for an id this
  build does not ship.
- `createWmsConnectorRegistry` builds a registry from definitions; dispatch is a
  map of factories, not a `switch`. `createReplayPolicy` is a required field on
  the definition, so a new connector fails `tsc` until somebody writes it down.
- **`WmsConnectorDef.hooks`** (round 2, `lib/connectors/wms/connector-hooks.ts`)
  carries the server-side flows built *around* the warehouse calls — the ASN
  state machine, product/bundle sync, the booked-in recheck, the dispatch
  precondition, the inbound-delta scope lock. The generic layer routes on the
  **presence** of a hook and never on the id, so adding a connector is a
  registration in `registry.ts` and not an edit to three dispatchers.
- **`WmsRegistrableConnector`** (round 2) is the type of `WmsConnectorDef.create`.
  It admits a connector that can verify a minted id, or one that only ever
  returns proven push results, and **nothing in between** — see below.
- `wmsCreateReplayPolicy` / `wmsAmbiguousCreateMayBeReplayed` /
  `wmsAmbiguousCreateRefusal` / `decideWmsHeldRelease` / `decideWmsPushReplay` /
  `decideWmsMissingRepush` / `runWmsOrderPushSweepCore` all take the registry as
  an optional parameter defaulting to the shipped one.
- `decorateWmsAsnState` / `unsupportedWmsAsnState` extracted from
  `app/actions/wms-asn.ts`, so the "the label drives all user-visible copy"
  promise is driven by a connector whose label is not "Mintsoft".

**The measurement this fixed.** Every pre-existing test that reached a
`client-side-dedupe-only` path did so with the literal `'shiphero'`. Once
ShipHero is unregistered that is an *unknown* id, and the policy lookup fails
closed on unknown ids — producing the identical refusal. Those tests would have
kept passing against a build in which the policy value had been deleted
outright. A registered fictitious connector is the only way to attribute the
refusal to the policy rather than to ignorance.

## What round 2 closed (Codex, four HIGHs)

The round-1 version of this document listed three "known abstraction leaks, left
as they are". They were not incidental: they were the reason the seam claim did
not hold. All four findings are fixed, and each fix is stated below as what it
makes **impossible**, not as what it checks.

1. **The ASN facade cannot resolve to one connector.** `app/actions/wms-asn.ts`
   routes on `hooks.asn`, which is declared by the connector's own registry
   definition. There is no id comparison left in it, so there is no arm a second
   connector can fall off. "Cannot do ASNs" and "nothing is enabled" remain
   *distinct* refusals, and the first names the connector it resolved.
2. **A connector cannot read another connector's delta cursor.** The three cursor
   rows, the reset-generation chain, the enable flag and the API-timezone *row*
   are all **derived from the connector id** (`wmsDeltaCursorKeys`,
   `wmsDeltaSettingKeys`), and the scope lock is either the connector's own
   (`hooks.deltaScopeLock`) or a default over its own rows. There is no shared
   key for a stale watermark to travel through. This mattered because the failure
   was silent: a Mintsoft watermark made a second connector's first sweep skip its
   backlog and report a clean pass. For `mintsoft` the derived names are
   byte-for-byte the existing rows, so nothing migrates. (The *default* behind the
   timezone row was still Mintsoft's until round 4 — see below.)
3. **The boundary guard no longer exempts the layer it protects.**
   `scripts/check-wms-connector-boundary.mjs` derives its literal list from
   `WMS_CONNECTOR_IDS` (a registration cannot add an unscanned literal), and
   `lib/domain/wms/`, `lib/jobs/wms/`, `lib/cron-jobs/wms.ts` and
   `app/actions/wms-asn.ts` are now **inside** the scan. Within the generic layer
   it reads code with comments excluded — a comment has no behaviour, and the doc
   comments there necessarily narrate which connector each rule was learned from.
   Turning it on lit up 145 real lines, which is what findings 1 and 2 look like
   from the outside. (The hand-rolled tokenizer this shipped with was replaced in
   round 4 — see finding 3 below.)
4. **An explicitly unverified create cannot be called SYNCED.**
   `needsVerification: true` with no `verifyPushedOrder` was independently
   expressible and resolved to SYNCED — the state the update, hold, cancel and
   dispatch passes act on — so IMS would amend or cancel an order under an id the
   connector had just disclaimed. `WmsRegistrableConnector` makes the combination
   **untypeable at the registry's factory**, which every production connector
   passes through; the push sweep additionally parks any such create at
   PENDING_VERIFY with the reason on the link, for a connector reached through a
   cast or written in JavaScript.

## What round 4 closed (Codex, four HIGHs)

Round 3's review found that two of round 2's fixes had been applied to the column
in front of the defect rather than to the defect, and that the guard which is
supposed to catch exactly that could not fail on three real inputs.

1. **A connector's delta cursor timezone cannot come from another connector.**
   Round 2 namespaced the `<id>_api_timezone` **row**; the *default behind it* was
   still Mintsoft's `Europe/London`, and that row is absent on every fresh
   install. The cursor is a wall-clock string, so a wrong zone shifts the window
   by hours and the orders in the gap are never read — the same silent-backlog
   defect, through a different column. `DISPATCH_DELTA_DEFAULT_TIMEZONE` is
   **gone**; `WmsConnector.deltaCursorTimeZone` states it, and
   `WmsRegistrableConnector` makes `fetchOrderDelta` **without** it untypeable at
   the registry factory. The sweep core carries no default at all: with no zone it
   formats in UTC, i.e. performs no conversion rather than somebody else's.
2. **The last two one-arm facades are gone.** `app/actions/wms-sync.ts` and
   `app/actions/wms-onboarding.ts` route on `hooks.syncDashboard` /
   `hooks.onboarding`, and their DTOs are **keyed by connector**
   (`connectorData[connectorId]`) rather than carrying a literal `mintsoft:`
   member — that member, not the dispatch, was the actual obstacle, because a
   second connector would have needed a second named member. Both files are out of
   the guard's allowlist and neither spells a connector id. **o3d-ph1y is closed.**
3. **The guard reads the real parse tree.** Rounds 2 and 3 hand-rolled the lexing:
   a character state machine blanked comments, and a regex scraped the id list.
   `const r = /[//]mintsoft/` and `<div>https://mintsoft</div>` both looked like
   the start of a line comment, so the literal was blanked, the scanner reached
   the newline in a normal state, the promised "mis-parse → raw scan" fallback
   never fired, and the guard exited 0 with a live literal in a protected file.
   It now walks TypeScript's own AST and inspects **leaf tokens**: comments are
   trivia and drop out by construction; regex literals, JSX text and template
   chunks are tokens and are scanned by construction. JSDoc, which the parser
   models as nodes, is excluded explicitly. A file with any parse diagnostic is
   scanned raw, which is strictly stricter.
4. **The id list must resolve in full or the guard refuses to run.** The old
   scraper pulled quoted strings out of the `WMS_CONNECTOR_IDS` initializer and
   hard-failed only on **zero** — so `['mintsoft', ACME_WMS_ID] as const` yielded
   one id and a registered `acme-wms` literal passed undetected, which is the
   precise failure the "derived, not copied" list exists to prevent. Ids are now
   resolved from the parse tree and any element that is not a string literal is a
   hard failure. Matching is a case-insensitive **substring** test, not a regex, so
   an id containing `+`, `.` or `|` matches itself and only itself.

`tests/scripts/wms-connector-boundary-guard.test.ts` runs the real script against
throwaway trees and asserts its **exit code** for each of those inputs, plus the
negatives (a comment in the generic layer is not a finding; `acme+wms` does not
match `acmewms`). Against the round-3 guard, five of those cases fail.

## Leaks that remain, deliberately

- `lib/domain/wms/booked-in-service.ts` is Mintsoft's booked-in webhook processor
  misfiled under the generic directory; it belongs under
  `lib/connectors/mintsoft/` (**o3d-c79v**). Its connector-agnostic half — the
  inbound-event processing lifecycle — was split out to
  `lib/domain/wms/inbound-event-status.ts` in round 2, which is what let the
  exception inbox and the retention sweep stop naming a connector at all.
- A link parked at PENDING_VERIFY by finding 4's runtime fail-safe carries its
  reason on the link and in the audit timeline, but does not yet surface in the
  exception inbox (**o3d-1rim**).

## Next

The Shopify and QuickBooks removals follow this pattern; the plan, including why
QuickBooks should wait, is in
[`../todo/connector-removal-plan.md`](../todo/connector-removal-plan.md).
