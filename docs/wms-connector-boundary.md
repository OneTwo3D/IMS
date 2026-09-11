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
- **`lib/connectors/wms/registry.ts`** — `WMS_CONNECTORS` descriptors +
  `getWmsConnector(id)` (resolves the connector implementation).
- **`lib/connectors/wms/active-connector.ts`** — `getActiveWmsConnectorId()` (the
  enabled WMS connector, with a single-connector fallback).
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

## Where the `mintsoft` literal is allowed

The literal is legitimate only in: the Mintsoft connector itself
(`lib/connectors/mintsoft/**`, `app/actions/mintsoft-sync.ts`), its per-connector
ingress (`app/api/cron/mintsoft-*`, `app/api/webhooks/mintsoft/**`,
`app/api/e2e/mintsoft/**`, `app/api/export/mintsoft-sync/**`, `lib/cron-jobs/wms-mintsoft.ts`),
the WMS dispatch facades/registry/panels above, the UI connector registry
(`/sync` `CONNECTORS`, the settings enable toggle), and per-connector ops/security
probes + cosmetic/plugin-registry files. See the allowlist in the guard.

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
| `String.fromCharCode(109, …)` / `fromCodePoint` | evaluated when every argument is a numeric literal |
| `'mint'.concat('soft')`, `'ab'.repeat(4)`, `.toLowerCase()`, `.trim()` | evaluated on folded receivers |
| `atob('bWludHNvZnQ=')`, `decodeURIComponent('%6Dintsoft')` | single-literal decoders evaluated |
| `obj['mint' + 'soft']` | the computed key is itself a folded expression |
| `'mint' + unknownVar + 'soft'` | **conservative**: an unknown operand reads as `''`, so this is a finding |
| `parts.join('')`, `String.fromCharCode(...codes)` | **conservative REJECT** — can glue or mint characters out of nothing, and no literal exists for a text scan to find. Waive it if it provably cannot spell an id |
| `String.fromCharCode(byte)`, `items.join(', ')` | **not** rejected — one argument cannot produce eight characters, and no id contains `, `, so such a separator cannot glue two non-ids into one |

**What it does not reach**, deliberately, and what happens instead:

- a value that arrives from **another module** — `'mint' + suffixFrom('./elsewhere')`,
  or a bare imported identifier. Not folded, not rejected: rejecting every `+` with
  a non-constant operand would fire on most of the repo, and a guard that fires on
  everything gets allowlisted into silence. The fragments in the *other* module are
  still scanned there;
- runtime transforms the fold does not model — `.replace`, `.slice`, `.split(…)` +
  `.reverse()`, `Buffer.from(…, 'base64').toString()`, `Array.from`, a `Proxy`, a
  value read out of JSON or a database row. A `.join('')` at the end of such a chain
  IS rejected; a transform that ends some other way is not;
- a **declaration file re-export** (`export { X } from './ids'` in a `.d.ts`) — a
  type has no runtime value to fold. The `.d.ts` is still scanned as text;
- `'mintsof'.repeat(2)`-style splices where an id is formed *across* a repetition
  boundary from a unit that is not itself an id. `repeat` folds when both operands
  are constant, so this is caught in the constant case only.

A folded finding is reported at the line of the **piece that supplied it**, not at
the line the expression starts on, so per-line waivers keep working on values
stitched together over many lines.

`tests/scripts/wms-connector-boundary-guard.test.ts` runs the real script against
throwaway trees and asserts its exit code for each of those behaviours — 34 cases,
positives and negatives. **Keep it
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
