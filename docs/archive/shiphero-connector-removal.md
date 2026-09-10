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

`tests/wms-second-connector-seam.test.ts` registers a **fictitious** WMS
connector (`acme-wms`, `tests/helpers/fictitious-wms-connector.ts`) — a complete
in-memory warehouse written only against the `WmsConnector` contract — and drives
the generic layer through it: registry construction, create-replay policy and
every refusal that turns on it, the held-release rule, the exception inbox's
replay affordance, `WmsUnresolvableRecordError` → UNRESOLVED mapping inside the
real dispatch sweep, per-order reconciliation for a WMS with no bulk delta, ASN
label decoration, and the WMS→shopping order-lookup resolver.

Supporting changes that made that possible, and that are the seam itself:

- `WmsConnector` is generic over its id, so a connector can exist for an id this
  build does not ship.
- `createWmsConnectorRegistry` builds a registry from definitions; dispatch is a
  map of factories, not a `switch`. `createReplayPolicy` is a required field on
  the definition, so a new connector fails `tsc` until somebody writes it down.
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

## Known abstraction leaks, left as they are

Worth knowing before the next removal — none of these are caused by this change,
but all of them are now un-pressured:

- `runWmsDispatchSweep` reads `mintsoft_inbound_delta_enabled`,
  `mintsoft_api_timezone` and `mintsoft_client_id` by name, and calls
  `isDispatchClientScoped(connectorId, …)`, inside the *generic* entrypoint.
- `app/actions/wms-asn.ts` dispatches on `if (connector === 'mintsoft')`, so
  adding a WMS with ASN support **does** require editing the facade, contrary to
  the promise in its own doc comment.
- `lib/domain/wms/post-maintenance-recheck.ts` returns early unless the connector
  is `mintsoft`.

These are legitimate today (Mintsoft is the only connector that implements those
capabilities) but each is a hardcoded connector literal in a module the boundary
guard allowlists, so nothing will flag them.

## Next

The Shopify and QuickBooks removals follow this pattern; the plan, including why
QuickBooks should wait, is in
[`../todo/connector-removal-plan.md`](../todo/connector-removal-plan.md).
