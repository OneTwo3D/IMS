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

Three test files, and they cover different halves of the same claim.

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

**`tests/wms-second-connector-seam-ui.test.ts`** (added in round 6) carries the
same claim the last layer: it calls the real `/sync` and onboarding facades with
`acme-wms` active and feeds their real output into the **real components**,
asserting on the markup an operator reads. Round 4 fixed the facades and left the
two files that render their DTOs matching one id and returning `null` for any
other — a blank configuration screen beneath a header naming the connector and a
card reading CONFIGURED.

**`tests/wms-second-connector-seam-plugin-state.test.ts`** (added in round 8) starts
one step earlier than any of them: somebody has to switch the connector **on**. It
moves the fictitious connector's switch on the real Settings screen, presses Save,
and follows the value through the real onboarding writer into the stored settings
row and back out through `getIntegrationPluginState` — the read every WMS enable gate
performs. Rounds 2–6 all began after that step had somehow succeeded, and it could
not: see `o3d-m0ad` below.

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

## What round 6 closed (Codex, two HIGHs)

Round 5's review found that round 4 had, for the fourth consecutive round, proved
a property **one layer short of where production decides** — and that the guard
rewritten in round 4 had acquired a new blind spot of exactly the shape it had
just removed.

1. **The renderer is now total over registered connectors, not one-arm.** Round 4
   moved `app/actions/wms-sync.ts` and `app/actions/wms-onboarding.ts` onto hooks
   and keyed their DTOs by connector. The files that *read* those DTOs were not
   changed: `app/(dashboard)/sync/wms-sync-panel.tsx` and
   `components/onboarding/wms-onboarding-connection.tsx` compared the id to a
   literal and rendered `null` otherwise — beneath a header naming the connector,
   beside an Integrations card reading **CONFIGURED**, under an enable switch that
   was on. A second registered connector got a blank configuration screen that
   looks like a working one, which is worse than an error because nothing on it
   invites doubt.

   Both dispatchers are now `Record<WmsConnectorId, …>`, **total over the id
   union**: adding an id to `WMS_CONNECTOR_IDS` without writing a panel and a form
   does not compile. Where a build can still hold an unknown id — a link row or a
   plugin-state row written by a connector this build no longer ships, a
   mixed-version deploy — the miss renders a NAMED, visible unsupported state, and
   it distinguishes *this build has no screen* from *the connector returned no
   data* from *this is not the active connector*, because those call for different
   things from an operator. `configured` is stated in words, so an operator with a
   live connection is never told to re-enter credentials.

   Two adjacent consumers went the same way. The `/sync` Integrations grid built
   its WMS cards from a **hand-written list**, so a registered, enabled connector
   nobody had added there got no card at all and was unreachable from the UI; the
   cards are now derived from the same total record as the panels. And the
   dashboard's WMS branch required the DTO to belong to the card that was clicked,
   so a *second* enabled connector's card fell through to the grid — a click that
   did nothing and said nothing. That is now the panel's `not-active` state.
   `WmsSyncDashboardData` gained `connectorLabel` (the onboarding envelope already
   had one) because the panel is a client component and cannot read the registry:
   without it, the one case where a human-readable name matters most showed a raw
   id.

   `tests/wms-second-connector-seam-ui.test.ts` drives the real components from
   the real facades with `acme-wms` active and asserts on the markup.

2. **The boundary guard evaluates constant string EXPRESSIONS, not tokens.** The
   round-4 rewrite inspects every leaf token of the parse tree — each one *on its
   own*, which is the same blindness one level up. `const id = 'mint' + 'soft'` is
   two tokens, neither containing the id; `'\x6dintsoft'` is one token whose
   source text is not the id while its value is. Both exited 0 with a live
   connector literal in a protected generic file.

   A second, purely **additive** pass now folds constant string expressions —
   concatenation to any depth, template literals (with and without substitutions),
   escape sequences, in-file `const` initializers and string enum members,
   `[…].join()`, `String.fromCharCode`/`fromCodePoint`, `.concat`, `.repeat`, case
   folds, `atob`/`decodeURIComponent` — and matches the **value**. It runs in every
   path (the token scan in the generic layer *and* the raw scan outside it, both of
   which read text rather than value) and it removes nothing, so a file it cannot
   parse keeps whatever the scan above found.

   What it cannot evaluate it treats conservatively. An unknown operand reads as
   the empty string, so `'mint' + suffix + 'soft'` is a finding. A construct that
   can glue or mint characters out of pieces the guard cannot see at all — an
   unfoldable `parts.join('')`, `String.fromCharCode(...codes)` — is **rejected on
   its own**, because no literal exists anywhere for a text scan to fall back on.
   That reject is bounded so it stays believable: `String.fromCharCode(byte)`
   cannot produce eight characters, and `items.join(', ')` cannot glue two non-ids
   into an id because no id contains `, `. Five sites in the tree carry a waiver.

   A folded finding is blamed on the **piece that supplied it**, not on the line
   the expression starts on: values are stitched from literals scattered over many
   lines, and blaming the first would move findings away from their cause and
   silently invalidate every per-line waiver already in the tree.

   `tests/scripts/wms-connector-boundary-guard.test.ts` grew from 15 real-script
   cases to 34. Thirteen of the new ones fail against the round-4 guard.

**What round 6 left out of reach.** The fold was a fold, not an interpreter. A
value that arrived from **another module**, or through a transform it did not model
(`.replace`, `Buffer.from(…, 'base64').toString()`), was out of reach — and so, as
it turned out, was a `+` between two numbers. Round 8 closed all of those; what
remains is below.

## What round 8 closed (Codex, three HIGHs)

Round 7's review found the seam proving a property one layer short **for the fifth
consecutive round** — this time in the server actions — plus two executable bypasses
of the round-6 guard.

1. **Capability is not state: `configured` has one source.** `app/actions/wms-sync.ts`
   and `app/actions/wms-onboarding.ts` answered `configured: false` from their
   *absent-hook* branch — a claim about the CONNECTION, made by a branch that had only
   established something about the BUILD. A live, correctly configured connector that
   simply ships no dashboard or no setup form was described to the operator as "not set
   up", whose remedy is to re-enter credentials that were never missing.

   `configured` is now read from `WmsConnector.isConfigured()` — the one **mandatory**
   method on the contract — on **every path, before the hook is looked up**, and
   `WmsSyncDashboard` / `WmsOnboardingConnection` no longer carry the field at all, so
   there is nowhere for a branch to write one. Capability is stated separately, by an
   empty `connectorData`.

   **The tests were pinning the wrong answer.** `tests/wms-second-connector-seam-production.test.ts`
   asserted `configured === false` for a hook-less connector whose fixture `isConfigured()`
   returned `true`, and the UI file asserted the markup read *"is not set up yet"* for the
   same connector. The fixture and the assertions disagreed about one connector and the
   assertions won — which is how this survived round 6, a round that audited exactly these
   two files. Both are rewritten, each now paired with the opposite case (a genuinely
   unconfigured connector must still be reported as such), and the fixture's
   `isConfigured()` is settable so the value can be driven rather than blessed.

   **One layer further out**, the re-audit found the consequence that mattered most.
   `components/onboarding/integrations-step.tsx` seeds `wmsConnected` from this value and
   gates the whole Integrations step on it, so the defect did not merely mislead: a
   registered connector with a live connection and no setup form made the wizard
   **impossible to complete**. That rule was an expression inside a `useEffect`, which the
   render harness never runs, so nothing could exercise it; it is now
   `lib/domain/onboarding/integrations-step-readiness.ts`, driven by the seam.

2. **A second connector can be ENABLED (`o3d-m0ad`).** `saveOnboardingPluginState` took a
   five-member object literal, overwrote five named members and upserted five named keys.
   `IntegrationPluginState` is *structurally assignable* to that literal, so passing the
   whole state compiled and a sixth id was silently dropped and handed back at whatever
   value the database already held. The Settings screen had one hard-written switch per
   plugin and two `as IntegrationPluginState` casts that suppressed the missing-member
   errors. Net effect: a connector could satisfy every totality check round 6 added and
   still be impossible to turn on through either production UI.

   The plugin id union, the setting-key map and the lock set are now **derived from
   `WMS_CONNECTOR_IDS`** (`lib/integration-plugin-keys.ts`); the wizard's writer takes
   `IntegrationPluginState` itself and walks `INTEGRATION_PLUGIN_IDS`; and the Settings
   screen renders the registry-derived catalogue
   (`lib/domain/integrations/plugin-catalog.ts`) with no casts left. Both the Settings
   toggle and `app/(dashboard)/settings/system/page.tsx` **came off the guard's allowlist**,
   because neither spells a connector id any more.
   `tests/wms-second-connector-seam-plugin-state.test.ts` moves the fictitious connector's
   switch, presses Save, and follows the value into the stored row and back out through
   `getIntegrationPluginState`.

3. **The guard folds arithmetic, follows imports, and rejects what it cannot evaluate
   (`o3d-lhjh`).** Round 6 folded **every** binary `+` as string concatenation, so
   `String.fromCharCode(100+9,100+5,…)` — which spells the connector id at runtime — folded
   its arguments to `1009`, `1005`, … and exited 0. That is the one failure mode worse than
   "cannot evaluate": *evaluated, confidently, to the wrong value*, which is never reported.
   A `+` between two numbers is now arithmetic, and the fold knows which it is looking at.

   Three of the four residues filed as `o3d-lhjh` were executable bypasses and are closed:

   - **cross-module concatenation** — the fold's universe is now the **repo**, not one file.
     `./…`, `../…` and `@/…` imports are followed (through named and `*` re-exports, with
     cycles terminating), and a *repo* constant it cannot follow to a value is a finding
     rather than an empty string. A **package** import is neither followed nor reported,
     because `node_modules` is not scanned at all;
   - **a constant `.replace`** — and `.padStart`, `.normalize`, and whatever is written next.
     The rule is deliberately not about the method: a constant string the fold has already
     evaluated, put through an operation it cannot evaluate, is a finding. Modelling
     `.replace` would close one member of an unbounded family, which is the sequence rounds
     3–7 kept losing;
   - **`Buffer.from(…, 'base64')`** — the same operation as `atob`, which round 6 already
     modelled, under another name. It is exactly evaluable, so it is evaluated; an encoding
     the guard cannot resolve makes it a reject.

   Only the **declaration-file re-export** remains, and it is genuinely runtime-harmless: a
   type cannot spell an id at runtime.

   **The cost was measured, not assumed.** Across 956 scanned files the new rules produce
   **two** findings, both waived in place with a reason (a `Math.max` the fold cannot
   evaluate, and a constant GUC name split on `.`). The rule the reviewer asked about —
   rejecting *every* `+` with a non-constant operand — was measured at **3,009** findings
   (1,977 with a string literal on one side), which is not a usable guard; the line therefore
   sits at *constants*, and a function body is not one. The guard suite grew from 34 cases to
   **47**; all 34 existing cases still pass.

**What no test covers.** A value produced by a **function defined in the same file**
(`function tail() { return 'soft' }; 'mint' + tail()`) is still read as data, and a `.d.ts`
re-export still has no runtime value to fold. Both are enumerated with their reasoning in
`docs/wms-connector-boundary.md` and tracked in `o3d-lhjh`.

## What round 10 closed (Codex, three HIGHs)

Round 9's review returned three HIGHs and nothing else. Each one is a *consequence of a
round-8 fix*, which is the pattern worth carrying into the Shopify and QuickBooks removals:
the round-8 changes were right about what they set out to fix and each opened a state
nobody had asked about.

1. **Two WMS connectors could be enabled, and only the first was ever used.** Making the
   Settings toggles registry-derived (round 8, item 2) is precisely what made a *second* WMS
   switch exist — and nothing added the rule that only one may be on. Neither writer refused
   it, and every routing site resolved the active connector with
   `WMS_CONNECTOR_IDS.find((id) => state[id])`. So an operator could enable a second
   warehouse, be told the save succeeded (it did), and watch every push, sweep and dispatch
   keep going to Mintsoft. **The operator is told the thing they asked for happened; it did
   not** — the quietest failure in the catalogue.

   Fixed in two halves, because either alone is insufficient. The state is now **unwritable**:
   `INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS` is a derived table (the WMS group is spread from
   `WMS_CONNECTOR_IDS`) and both writers evaluate it **under the selection lock against the
   state their write results in**, so two *partial* writes cannot assemble it either. And it
   is **never guessed**: `lib/connectors/wms/enabled-connector.ts` is the one reader, it
   answers `none`/`one`/`ambiguous`, and ambiguous routes nowhere with its own reason.
   Sixteen inline `find(...)` call sites became one function — which also removes the shape
   that bit this branch six times, a rule fixed in one reader and left in another.

   **Why exclusivity rather than a persisted `active_wms_connector` row** (the reviewer
   offered both): an explicit active row is a *second* source of truth beside the
   `plugin_<id>_enabled` rows that the module-visibility check, the onboarding readiness
   step, the /sync gate and the switches all read, and two sources can disagree. That is the
   same defect class, one layer over.

2. **The new `configured` predicate could make onboarding impossible to OPEN.** Round 8's
   move of `configured` onto `isConfigured()` was argued behaviour-preserving *by
   inspection*. It was not. The value it replaced came from the connector's own hook, where
   `mintsoftHasAuthMaterial` **catches** `MintsoftAuthModeError`; `isConfigured()` goes
   through `getMintsoftApiConfiguration()`, which **throws** on a malformed stored or
   environment auth mode. Awaited bare inside `/onboarding`'s `Promise.all`, one bad
   `mintsoft_auth_mode` row failed the whole wizard render — and one rejected read on `/sync`
   drops all 22 panels. Both are where that value is corrected, so the misconfiguration
   removed its own remedy.

   The rule is now stated and enforced at the boundary: **a question that throws has not been
   answered, and a connector that cannot say whether it is configured is not configured.**
   `isWmsConnectorConfigured` (registry) rethrows framework control flow, logs, and answers
   `false`; neither facade holds a connector instance to call the predicate on any more.

3. **Cross-module `Buffer` constants walked past the guard.** `foldImported` copied `exact`,
   `opaque` and `numeric` out of the remote fold **by name** and dropped `binary` — a flag
   added in round 8, after that copy was written. So `Buffer.from('bQBpAG4A…','base64')`
   exported from one module and `.toString('utf16le')`-ed in another arrived as an ordinary
   latin1 string, the interleaved NULs survived, and the guard exited 0 on a value that is
   the connector id at runtime. The same expression in *one* file had always failed, so this
   was a closed spelling arriving through a module boundary.

   It now carries the remote fold **whole** (`{...remote}`), rewriting only `pieces` and
   `opaque`, which are the two fields that are meaningless outside their own `SourceFile`.
   Enumerating fields is the bug; the next flag would have been dropped too. Guard suite: 47
   cases → **50**, all 47 still passing.

## What round 12 closed (Codex, three HIGHs and a MEDIUM)

Round 11's review found three HIGHs and one MEDIUM. Two of the three are, again, *a rule
applied to everything except the one place it had to be applied to*.

1. **The canonical id list did not make the registry exhaustive.** Round 6 made the
   `/sync` panels a total `Record<WmsConnectorId, …>` and round 8 made the plugin toggles
   registry-derived, so a registered id with no *screen* stopped compiling. Nothing did the
   same for the **definitions** — `BUILT_IN_WMS_CONNECTORS` was `readonly WmsConnectorDef[]`
   — and that is the one list that actually has to be complete. Adding an id, a panel and a
   form while omitting the definition typechecked: the settings screen offered the connector,
   the writer persisted it, the resolver selected it, and every route reaching
   `getWmsConnector` threw `Unknown WMS connector` **at request time**.

   The registry is now the id list crossed with one definition each.
   `BUILT_IN_WMS_CONNECTOR_REGISTRATIONS` is `Record<WmsConnectorId, WmsConnectorRegistration>`
   (the definition *minus* its id, which the key supplies — so the id cannot be written twice
   differently), and `createRegisteredWmsConnectorRegistry(ids, registrations)` walks the list.
   Missing definition: a `tsc` error. Extra definition: an excess-property error. And because
   a build can still reach the runtime with the two disagreeing — a `mock.module`, a
   JavaScript caller, a mixed-version deploy — the derivation **throws at module evaluation**,
   naming the id, where a deploy sees it.

   **The seam missed it because the fixture mocked the two independently.** Every seam file
   widened `WMS_CONNECTOR_IDS` inline *and*, separately, hand-built a registry from an array
   of definitions — so the fixture could hold the exact state production forbids, and four
   green suites proved nothing about it. One constant (`SEAM_WMS_CONNECTOR_IDS`) now feeds
   both, through the shipped derivation, and the registry mock **re-binds the default source**
   of the real lookups instead of re-implementing them as one-liners.

2. **`WmsConnectorDef.available` was read by nothing.** It is documented as "false for a
   connector that is registered but not offered to operators yet". The registry-derived
   toggles (round 8) and the registry-derived `/sync` cards (round 6) both walked *every*
   registered id, and the `/sync` grid wrote `available: true` into every WMS card itself — a
   second source for a fact the definition already states. A staged connector therefore got a
   live switch, could be enabled by either writer, and became the connector every push, sweep
   and dispatch routed to.

   `available` is consulted in one place (`isIntegrationPluginAvailable`,
   `lib/domain/integrations/plugin-catalog.ts`) and read from there by the settings catalogue,
   the `/sync` grid (the ids are resolved server-side and passed down; the hardcoded `true` is
   gone, not synced), the `?connector=` deep link, and **both** plugin-state writers — which
   now call ONE rule function, `findIntegrationPluginWriteConflict`, so neither can hold half
   the ruleset. Availability is checked only on the ids being turned **on**: an unavailable
   connector that is somehow enabled keeps its switch, or the misconfiguration removes its own
   remedy again.

3. **The authoritative `configured` predicate accepted an unusable whitespace token.**
   Round 10 made `isMintsoftConfigured` the source for the onboarding tick and the `/sync`
   badge. Its credentials branch tested the cached `mintsoft_api_key` **without trimming**,
   while the `mintsoftHasAuthMaterial` it replaced trimmed. A whitespace-only row — or a
   `MINTSOFT_API_KEY` environment variable of spaces, which never passes through the validated
   settings action — reported a set-up connection while every request failed. Filed as
   `o3d-pow3` in round 11 and ruled BLOCKS in round 12, correctly: the divergence was cosmetic
   until round 10 made the path decide what operators see.

   Both divergences on `o3d-pow3` resolve the same way — **this predicate is true only of a
   connection something could actually be sent over**. The cached key is trimmed; and the
   *narrowed* base-URL answer (an unparseable stored URL now reads as absent, where the old
   predicate accepted any non-empty string) is **kept and declared**, because the normalised
   value is the only base URL a Mintsoft request is ever built from.

4. (MEDIUM) **Ambiguity still produced false operator messages.** Round 10 gave the resolver a
   three-valued answer and three callers collapsed it back to two: the exception inbox said
   "No WMS connector is enabled" and the drift isolate/retry actions said the connector "is not
   enabled", with two switches visibly on; `/sync` said another connector "currently" serves
   the app, in the one state where none does. Each now takes
   `resolveEnabledWmsConnectorSelection()` and reports the reason, and the WMS panel has
   `ambiguous` and `none-active` states of its own. **The UI test named for this never reached
   it** — the "SECOND enabled connector" case had only one connector enabled — so it is
   renamed to what it exercises and a real two-enabled case added beside it.

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
