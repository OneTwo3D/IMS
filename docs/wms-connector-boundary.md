# WMS / 3PL connector boundary (frozen)

The IMS treats the 3PL/WMS layer as **connector-agnostic**. Core app flows — sales,
purchase orders, transfers, stock, onboarding, settings, the `/sync` wiring, and
external fulfillment — go through a generic boundary and never branch on a
specific connector (`mintsoft`). A second WMS connector is added
by **implementing the contract + registering it**, with no edits to those core
flows.

This mirrors the shopping (`shopping-registry.ts`) and accounting
(`accounting-registry.ts`) boundaries. Epic: `onetwo3d-ims-h02x.10`.

## The contract (stable, app-facing)

- **`lib/connectors/wms/types.ts`** — the `WmsConnector` interface plus
  `WMS_CONNECTOR_IDS` / `WmsConnectorId` (the single source of truth for connector
  ids) and `isWmsConnectorId`. This module is server-free so client components can
  import the id guard.
- **`lib/connectors/wms/registry.ts`** — `BUILT_IN_WMS_CONNECTOR_REGISTRATIONS` +
  `getWmsConnector(id)` (resolves the connector implementation). The registry is the id
  list **crossed with one definition each**: the record is
  `Record<WmsConnectorId, WmsConnectorRegistration>` (a definition *minus* its id, which
  the key supplies), and `createRegisteredWmsConnectorRegistry(ids, registrations)` walks
  `WMS_CONNECTOR_IDS`. A registered id with no definition is a `tsc` error; a definition
  for an unregistered id is an excess-property error; and because a build can still reach
  the runtime with the two disagreeing (a `mock.module`, a JavaScript caller, a
  mixed-version deploy) the derivation **throws at module evaluation, naming the id**
  (round 12). `BUILT_IN_WMS_CONNECTORS` / `WMS_CONNECTORS` are the registry's own list.
- **`lib/connectors/wms/active-connector.ts`** — `getActiveWmsConnectorId()` (the
  enabled WMS connector, with a single-connector fallback),
  `getEnabledWmsConnectorId()` (no fallback) and
  `resolveEnabledWmsConnectorSelection()` (the same answer with its *reason*, for the
  callers that put a sentence in front of an operator).
- **`lib/connectors/wms/asn-types.ts`** — connector-agnostic ASN view-models.
- **`lib/connectors/wms/order-lookup.ts`** — `resolveWmsOrderLookupConnector`.

## Dispatch facades (core flows call these, never a connector module)

- **`app/actions/wms-asn.ts`** — PO/transfer receive-ASN state + create.
- **`app/actions/wms-sync.ts`** — `/sync` dashboard data.
- **`app/actions/wms-onboarding.ts`** — onboarding connection-data.
- **`app/actions/wms-order-status.ts`** — live order status for the sales-order chip.

Each resolves the active connector and dispatches to **whatever that connector
registered** — `hooks.asn`, `hooks.syncDashboard`, `hooks.onboarding` on its
`WmsConnectorDef` (`lib/connectors/wms/connector-hooks.ts`). Routing is on the
**presence** of a hook, never on the id: a connector that omits one is reported as
"cannot do this", *named*, which is deliberately distinct from "nothing is
enabled".

**A hook states a payload and never a connection state** (round 8). `configured` is
read from `WmsConnector.isConfigured()` — the one mandatory method on the contract —
on every path, *before* the hook is looked up, and the hook result types carry no
such field for a branch to write.

**And it is read through `isWmsConnectorConfigured`, never called bare** (round 10).
`isConfigured()` answers a question, and *a question that throws has not been
answered*: Mintsoft's goes through `getMintsoftApiConfiguration()`, which refuses a
malformed stored or environment auth mode rather than defaulting it. Round 8 awaited
it unguarded inside the reads `/onboarding` gathers with `Promise.all` and `/sync`
with `Promise.allSettled` — so one bad `mintsoft_auth_mode` row failed the whole
wizard render and made the **entire** /sync dashboard unavailable (one rejection there
drops all 22 panels, not just the WMS one). Both are the screens an operator uses to
correct that value, so the misconfiguration removed its own remedy. **A connector that
cannot say whether it is configured is NOT configured**: the containment lives on the
registry (`lib/connectors/wms/registry.ts`), rethrows framework control flow first,
logs, and answers `false` — which is exactly the state that keeps the corrective form
on screen. No facade holds a connector instance to call the predicate on any more. Capability and state are different questions: round
6's no-hook arms answered `configured: false`, i.e. a claim about the CONNECTION from
a branch that had only established something about the BUILD. The consequence was not
only misleading copy — `components/onboarding/integrations-step.tsx` gates the whole
Integrations step on that value, so a registered connector with a live connection and
no setup form in this build made the wizard **impossible to complete**, offering a
remedy (finish setting it up) that no screen could perform. That rule now lives in
`lib/domain/onboarding/integrations-step-readiness.ts` as a pure function, because
inside a `useEffect` in a 700-line client component nothing could exercise it.

The DTOs the first three return are **keyed by connector**
(`connectorData[connectorId]`), not by a named member per connector. That shape is
load-bearing: a literal `mintsoft:` member is what kept `wms-sync.ts` and
`wms-onboarding.ts` as one-arm dispatchers for two review rounds, because a second
connector would have needed a second named member. The per-connector UI narrows
the opaque payload in its own dispatcher
(`app/(dashboard)/sync/wms-sync-panel.tsx`,
`components/onboarding/wms-onboarding-connection.tsx`) — adding a connector means an
entry there, not an edit to the page/step.

Those two dispatchers are **`Record<WmsConnectorId, …>`, total over the id union**
(round 6). A one-arm `if` there was the same defect as a one-arm facade and one
layer harder to see: it rendered `null` for every other connector, beneath a header
naming it, a card reading CONFIGURED and an enable switch that was on — a blank
configuration screen that looks like a working one. Totality means a registered
connector with no UI **does not compile**; a build that nevertheless holds an
unknown id (a link row or plugin state from a connector this build no longer ships)
renders a NAMED unsupported state, distinguishing *no screen in this build* from
*the connector returned no data* from *not the active connector*, and saying in
words whether the connection is configured. **No path renders nothing.** The
`/sync` Integrations cards and their logos are derived from the same record, so a
registered connector cannot be missing a card either.
`tests/wms-second-connector-seam-ui.test.ts` drives the real components from the
real facades with `acme-wms` active and asserts on the markup.

## Connector facts the generic layer must not default

Some values look like configuration but are facts about a particular warehouse.
The generic layer must never carry a default for one, because the default is
always some *other* warehouse's answer and getting it wrong is silent:

- **`WmsConnector.deltaCursorTimeZone`** — the zone `fetchOrderDelta`'s cursor is a
  wall clock in. `WmsRegistrableConnector` makes `fetchOrderDelta` without it
  untypeable, and `lib/domain/wms/dispatch-sweep.ts` holds no default: with no zone
  it formats in UTC (no conversion) rather than in somebody else's zone. A tenant
  override lives in the connector's own `<id>_api_timezone` setting row.
- **`WmsConnectorDef.createReplayPolicy`** — whether the warehouse's own create
  refuses a duplicate. Required, so a new connector fails `tsc` until it is written
  down.
- **`WmsConnectorDef.available`** — whether this build **offers** the connector to
  operators. See below.

## `available`: registered, and not offered

`available: false` means "registered but not offered to operators yet". Until round 12
**nothing read it**: the registry-derived Settings toggles (round 8) and the
registry-derived `/sync` cards (round 6) walked every registered id, and the `/sync` grid
wrote `available: true` into every WMS card itself — a second source for a fact the
definition already states. A staged connector got a live switch, could be enabled by
either writer, and became the connector every push, sweep and dispatch routed to.

It is consulted in exactly one place, `isIntegrationPluginAvailable`
(`lib/domain/integrations/plugin-catalog.ts`), and read from there by:

- **the Settings catalogue** — `listIntegrationPluginDescriptors` omits an unavailable
  plugin's switch;
- **the `/sync` Integrations grid** — `listAvailableWmsConnectorIds()` is resolved on the
  server (the registry cannot enter a client bundle) and passed to
  `listWmsIntegrationCards`, which is now the only place that decides a card's
  `available`. The hardcoded `true` is **gone**, not kept in step;
- **the `/sync` `?connector=` deep link**, so greying a card out does not leave the URL
  live;
- **both plugin-state writers**, through `findIntegrationPluginWriteConflict` — ONE
  function that holds exclusivity *and* availability, so a writer cannot hold half the
  ruleset.

**Only the ids being turned ON are checked**, and an unavailable plugin that is somehow
enabled keeps its switch (flagged `available: false`, copy saying to switch it off).
Otherwise the rule would remove its own remedy — a row can say enabled after a restore, a
direct `UPDATE setting`, or a build that withdrew a connector that was on.

Non-WMS plugins answer `true` by construction: the four of them are enumerated because
there is no registry to derive them from, so there is no staged-registration state for one
to be in. (The `available` flags on the shopping and accounting registries govern
connector *selection* in the Numbering and Company screens, a different question; both
ship `true`.)

## Where the `mintsoft` literal is allowed

The literal is legitimate only in: the Mintsoft connector itself
(`lib/connectors/mintsoft/**`, `app/actions/mintsoft-sync.ts`), its per-connector
ingress (`app/api/cron/mintsoft-*`, `app/api/webhooks/mintsoft/**`,
`app/api/e2e/mintsoft/**`, `app/api/export/mintsoft-sync/**`, `lib/cron-jobs/wms-mintsoft.ts`),
the WMS dispatch facades/registry/panels above, the UI connector registry
(`/sync` `NON_WMS_CONNECTORS` — the WMS cards are derived, never listed), and
per-connector ops/security probes + cosmetic/plugin-registry files. See the allowlist in the guard.

The Settings plugin toggle is **no longer** on that list (round 8, `o3d-m0ad`). It used
to hard-write one switch per plugin — one of them the shipped WMS connector's — behind
two `as IntegrationPluginState` casts, so a registered connector had no toggle at all.
It now renders the registry-derived catalogue in
`lib/domain/integrations/plugin-catalog.ts` and spells no connector id, which is what
lets it be scanned rather than exempted.

## Exactly one WMS connector, and no silent winner

`WMS_CONNECTOR_IDS` is a list, plugin state is a flag per id, and until round 10 the
app had **no rule** that only one WMS flag may be on. Round 8's registry-derived
Settings toggles are what made a second WMS switch exist; nothing added the rule. So
enabling a second connector beside Mintsoft committed, reported success, and changed
nothing — every routing site resolved the active connector as
`WMS_CONNECTOR_IDS.find((id) => state[id])`, i.e. **first enabled wins, silently**.

Two halves, and both are needed:

- **Unwritable.** `INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS` /
  `findIntegrationPluginExclusivityConflict` (`lib/integration-plugin-keys.ts`) hold
  the shopping pair, the accounting pair and — spread from `WMS_CONNECTOR_IDS` — the
  WMS group, so a newly registered connector is under the rule the day it is
  registered rather than the day somebody remembers the table. Both plugin-state
  writers (`saveIntegrationPluginState`, `saveOnboardingPluginState`) evaluate it
  **under the connector-selection lock, against the state the write results in**,
  which is what stops two *partial* writes assembling a state neither payload asked
  for.
- **Not guessed.** "This app cannot write it" is not "it cannot exist" — a restore or
  a direct `UPDATE setting` still can. `lib/connectors/wms/enabled-connector.ts` is
  the single reader: `resolveEnabledWmsConnector(state)` answers `none` / `one` /
  `ambiguous`, and **`ambiguous` routes nowhere**, with its own reason, never folded
  into "no WMS connector is enabled" while two switches are visibly on. Every
  production resolution site reads it; the one exception is
  `app/actions/stock-counts.ts`, which *screens* bindings rather than routing and
  therefore honours every enabled connector's binding (`enabledWmsConnectorIds`).
  `app/(dashboard)/sync/page.tsx` counts an ambiguous WMS as "a plugin is enabled" so
  the page that links to the offending switches stays reachable. And
  `app/actions/wms-asn.ts` refuses with the contradiction rather than with "No WMS
  connector is enabled." — `getActiveWmsConnectorId` falls back to the first registered
  connector when *nothing* is enabled, so that facade's "nothing resolved" arm is now
  reached in practice only by a contradictory selection, and the no-connector sentence
  would be the one statement that is certainly false there.

**Round 12 finished the callers.** Three of them still turned the three-valued answer back
into two by taking `getEnabledWmsConnectorId()` and testing it for null:
`recordWithdrawnDespatch` said "No WMS connector is enabled", and
`isolateUnresolvedDriftCohort` / `retryUnresolvedDriftCohort` said the connector "is not
enabled" — while it was enabled, just not alone, and the remedy is the opposite one (turn a
switch *off*, not on). They take `resolveEnabledWmsConnectorSelection()` and report the
reason; the wording for the `none` state is unchanged, and each case is paired with its
`none` contrast so "says the ambiguity" cannot be satisfied by a message that stopped
mentioning the enabled state at all. The `/sync` WMS panel likewise gained `ambiguous` and
`none-active` states: it used to render both as `not-active`, whose sentence ("another
connector currently does") claims some other connector is serving the app in the two states
where none is.

`getWmsOnboardingConnectionData` is the deliberate exception on the other side: it keeps
`?? WMS_CONNECTOR_IDS[0]`, so an ambiguous selection still renders the first registered
connector's setup form. That is not routing — it decides which form appears, and the
wizard's job in a broken state is to be *reachable*.

`getActiveWmsConnectorId()`'s legacy fallback to the first registered connector still
applies to **none**, and deliberately not to **ambiguous**: falling back there would be
the winner-picking this removes.

## Enforcement

`scripts/check-wms-connector-boundary.mjs` (run by `npm run check:all` and the
**WMS Connector Boundary Guard** CI workflow) fails the build if a registered
connector id appears in any scanned `app`/`lib`/`components` file outside that
allowlist. It reads the ids **and** the files through the TypeScript compiler:

- the id list is resolved from the parse tree of `WMS_CONNECTOR_IDS`, and any
  element that is not a string literal is a **hard failure** rather than a silently
  shorter scan;
- inside the generic WMS layer it inspects the parse tree's **leaf tokens**, so
  comments (including JSDoc) are excluded by construction while regex literals, JSX
  text and template chunks are included by construction;
- outside that layer files are scanned raw, comments included;
- a file with any parse diagnostic is scanned raw — a mis-parse can only make the
  guard stricter;
- matching is a case-insensitive substring test, never a regex, so an id containing
  a metacharacter matches itself and only itself;
- and a second, purely **additive** pass folds **constant string expressions** and
  matches their **value**, because both scans above read *text* and a constant
  expression's value is not its text (round 6).

### What the constant-expression fold evaluates

A leaf token is inspected on its own, so `const id = 'mint' + 'soft'` and
`'\x6dintsoft'` were both invisible to the round-4 guard. The fold resolves:

| Spelling | Handled how |
| --- | --- |
| `'mintsoft'` | literal — the cooked value, so escapes (`'\x6dintsoft'`, `'mint\u0073oft'`) fold |
| `` `mintsoft` `` | no-substitution template — cooked value |
| `'mint' + 'soft'`, any depth | folded to the concatenation |
| `` `mint${'soft'}` `` | template spans folded when the substitution is constant |
| `('mint' as const) + ('soft' satisfies string)` | wrappers (`as`, `satisfies`, parens, `!`) unwrapped |
| `const a = 'mint'; a + 'soft'` | in-file `const` initializers resolved (a name declared twice resolves to nothing) |
| `enum W { A = 'mint' } W.A + 'soft'` | in-file string enum members resolved |
| `['mint','soft'].join('')` | array-literal join with a constant separator |
| `String.fromCharCode(109, …)` / `fromCodePoint` | evaluated when every argument folds to a number |
| `100 + 9`, `0x41 + 1`, `60 * 60 * 1000`, `-(-109)` | **arithmetic, not concatenation** (round 8). A `+` between two numbers adds; a `+` touching a string concatenates. Round 6 folded every `+` as concatenation, so `String.fromCharCode(100+9, …)` folded to `'1009'` and produced unrelated characters *exactly* — the one failure worse than "cannot evaluate", because it is not reported |
| `'mint'.concat('soft')`, `'ab'.repeat(4)`, `.toLowerCase()`, `.trim()` | evaluated on folded receivers |
| `atob('bWludHNvZnQ=')`, `decodeURIComponent('%6Dintsoft')` | single-literal decoders evaluated |
| `Buffer.from('bWludHNvZnQ=', 'base64').toString('utf8')` | evaluated (round 8) — the same operation as `atob`, which was already modelled, under another name. An encoding the guard cannot resolve makes it a **reject**, not a pass |
| `export const B = Buffer.from('bQBpAG4A…','base64')` in one module, `B.toString('utf16le')` in another | evaluated (round 10). `foldImported` copied `exact`/`opaque`/`numeric` **by name** and dropped the `binary` flag, so the bytes arrived as an ordinary latin1 string, the NULs survived the decode, and the guard exited 0 on a value that is a connector id at runtime. It now carries the remote fold **whole**, rewriting only the two fields that are meaningless outside their own `SourceFile` |
| `import { TAIL } from './ids'; 'mint' + TAIL` | **followed across the module boundary** (round 8) and folded there. `./…`, `../…` and `@/…` specifiers resolve to repo files, through named and `*` re-exports, with an import cycle terminating as a reject |
| `obj['mint' + 'soft']` | the computed key is itself a folded expression |
| `'mint' + unknownVar + 'soft'` | **conservative**: an unknown operand reads as `''`, so this is a finding |
| `parts.join('')`, `String.fromCharCode(...codes)` | **conservative REJECT** — can glue or mint characters out of nothing, and no literal exists for a text scan to find. Waive it if it provably cannot spell an id |
| `'mintXsoft'.replace('X','')`, `'soft'.padStart(8,'mint')`, `.normalize()`, any unmodelled method **on a constant the fold already evaluated** | **conservative REJECT** (round 8). The rule is about the shape, not the method: modelling `.replace` would close one member of an unbounded family. Measured cost across 956 scanned files: **two** waivers, both numeric |
| a **repo** import the fold cannot follow to a `const` — a missing file, a file that will not parse, an export that is a function | **conservative REJECT** (round 8). It is a constant expression the guard has admitted it cannot evaluate; reading it as `''` is exactly what let the split spelling through |
| `String.fromCharCode(byte)`, `items.join(', ')` | **not** rejected — one argument cannot produce eight characters, and no id contains `, `, so such a separator cannot glue two non-ids into one |
| `input.replace(…)`, `Buffer.from(body, 'utf8')` on a **runtime** value | **not** rejected — the receiver does not fold, so there is no constant the guard has failed to evaluate. Ordinary code transforms data, not literals, which is why the rule above costs almost nothing |
| `import path from 'node:path'; 'wms' + path.sep` | **not** followed and **not** rejected — `node_modules` is not scanned at all, so demanding evaluability of a package import would be the guard requiring of third-party code a property it never checks |

**What it does not reach**, deliberately, and what happens instead:

- a value produced by a **function defined in the same file** —
  `function tail() { return 'soft' } const id = 'mint' + tail()`. A call is runtime
  data as far as the fold is concerned, and reading every call as unbounded would
  reject most of the repo. Measured: rejecting every `+` with a non-constant operand
  produces **3,009** findings across 956 files (1,977 of them with a string literal
  on one side), which is not a usable guard — so the line sits at *constants*, and a
  function body is not one. Tracked in `o3d-lhjh`;
- a **declaration file re-export** (`export { X } from './ids'` in a `.d.ts`) — a
  type has no runtime value to fold. The `.d.ts` is still scanned as text;
- `'mintsof'.repeat(2)`-style splices where an id is formed *across* a repetition
  boundary from a unit that is not itself an id. `repeat` folds when both operands
  are constant, so this is caught in the constant case only.

A folded finding is reported at the line of the **piece that supplied it**, not at
the line the expression starts on, so per-line waivers keep working on values
stitched together over many lines.

`tests/scripts/wms-connector-boundary-guard.test.ts` runs the real script against
throwaway trees and asserts its exit code for each of those behaviours — 50 cases,
positives and negatives, 13 of them added in round 8 for the numeric fold, the
cross-module fold, the unmodelled-operation reject, `Buffer.from` and an import
cycle, and 3 in round 10 for a `Buffer` constant crossing a module boundary in two
encodings plus the negative that must still exit 0. **Keep it
passing and keep adding to it**: this guard printed "clean" for two review rounds
with a live literal in a protected file, and a guard that cannot fail is worse than
no guard because it is believed.

For a genuinely connector-specific reference, add the path to the allowlist or add
a per-line waiver:

```
// wms-connector-boundary-ok: <ticket-or-date>: <reason>
```

Product-mutation sync is dispatched generically too: `app/actions/products.ts`
calls `scheduleWmsProductSync` (`lib/domain/wms/product-sync-dispatch.ts`), which
resolves the active WMS connector — no connector literal in the product actions.
