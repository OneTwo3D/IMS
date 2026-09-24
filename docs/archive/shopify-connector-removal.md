# Archived: the Shopify shopping connector

**Removed on branch `o3d-remove-parked-connectors`.**
**Last commit in which the connector was part of the ACTIVE tree:
`530229e69f17490da5fa3cd4340c587845931638`** (`development`, 2026-09-24, "Guard every concurrency
test file with the scratch-database check, at import (o3d-yvn8)" #696).
**Annotated tag: `archive/shopify-connector`** — points at that commit.
**The connector's own source is still in the tree**, at
[`archive/connectors/shopify/`](../../archive/connectors/shopify/) — not built, not type-checked,
not linted, not tested. See [`archive/connectors/README.md`](../../archive/connectors/README.md)
for how that exclusion is enforced and what reviving one costs.

The owner's decision (verbatim, 2026-09): *"also remove the QuickBooks, Shopify and Shiphero
connectors from the active codebase (archive the code but remove it from active installs). but keep
the generic design of the ims so it is possible to add later on different connectors."* Active
connectors are WooCommerce, Mintsoft and Xero (connector priority 2026-08).

This removal follows the plan in `docs/todo/connector-removal-plan.md`, which surveyed it in detail.

---

## It was a half-connector, and that is why the risk was low

Real Shopify Admin GraphQL existed for `fetchOrders`, `fetchProducts`, `syncStock`, product links,
delivery status and HMAC webhook verification. But `processShopifyWebhookPayload` wrote every drained
event back as `FAILED` with "Shopify webhook processing is not implemented yet", and manual order and
product sync returned "not wired yet". **No order and no product ever entered IMS via Shopify.**

## What moved to `archive/connectors/shopify/`

| Original path | What it was |
| --- | --- |
| `lib/connectors/shopify/{index,api,settings,links,delivery}.ts` | 1,291 lines: Admin GraphQL client, credentials/settings, HMAC webhook verification, product/order link resolution, delivery status |
| `lib/jobs/shopify/process-shopping-webhook-events.ts` | The inbox drainer adapter (which marked everything FAILED) |
| `app/(dashboard)/sync/shopify-sync-client.tsx` | The `/sync` connector panel |
| `public/images/shopify-banner.png` | The card/panel logo |
| `tests/shopify-webhook-inbox.test.ts` | Its own unit test |
| `lib/connectors/not-implemented.ts` | Shopify was its ONLY importer, and `notImplementedError` had zero callers anywhere. ShipHero had a private copy, which is why this survived the first removal |
| `docs/todo/shopify-connector-followup-plan.md` | The follow-up plan, which is now closed-not-done |

## Registrations and wiring removed from the active tree

- `ShoppingConnectorId` is now a union of one; the `shopify` entry left `SHOPPING_CONNECTORS`.
- `NON_WMS_INTEGRATION_PLUGIN_IDS` lost `shopify`, so `plugin_shopify_enabled` is no longer a key
  this build writes, reads, locks or offers a switch for.
- **The `shopping` exclusivity group is deleted, not shrunk.** WooCommerce's only partner was
  Shopify. A one-member group can never conflict, so leaving it would be a rule that reads as
  enforced and enforces nothing.
- Thirteen `case 'shopify':` arms in `lib/shopping.ts`; the `shopify` element of the
  `drainers` map in `lib/jobs/shopping/drain-inbox.ts`; `persistShopifyWebhookEvent` and the second
  member of `ShoppingWebhookEventConnector`; `shopify_invoice_pdf_secret` from the invoice-PDF secret
  map; the three `SHOPIFY_*` `SETTING_ENV_FALLBACKS` and `SENSITIVE_SETTING_KEYS` entries.
- Server actions: `getShopifySyncSettings`, `saveShopifySyncSettings`,
  `get/saveShopifyConnectorCredentials`, `getShopifySyncLogs`, `triggerShopifyManualSync`.
- UI: the `/sync` card, logo, deep link and panel; the onboarding Integrations-step switch, credential
  form and save handler; the onboarding Products-step import button; the Mintsoft order-lookup
  connector option (`/sync` and onboarding).
- Cron: the `shopify` half of `app/api/cron/shopping-webhook-inbox`'s `Promise.all`.
- Env: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`,
  `SHOPIFY_INVOICE_PDF_SECRET` from `.env.example` and `scripts/provision-ims-tenant.env.example`,
  and the `SHOPIFY_STORE_DOMAIN` waiver from `scripts/documented-env-var-allowlist.json` (that file
  fails on a stale entry, so the waiver had to move in the same commit).

## Dead-on-removal generic code, also deleted

`lib/shopping.ts` lost `computeKitAvailability` and `buildShoppingStockUpdates` — about 185 lines of
"connector-agnostic" stock-update construction (kit availability, warehouse scoping, SKU and
lifecycle skip accounting) whose **only** caller was Shopify's `syncStock`. WooCommerce has never
used it: `pushStockToWc` builds its own updates inside the connector, under its own advisory lock and
settings snapshot.

This is the ShipHero `stock-sync-helpers.ts` finding repeating, and it is the item the removal plan
asks to be recorded rather than quietly dropped: a module presented as the shared, neutral layer was
in fact a *second* implementation that one connector used and the other did not. The generic-looking
name was the only generic thing about it. A future storefront should expect to write its own builder,
or to lift WooCommerce's out of the connector deliberately — not to find one waiting.

Recoverable at `git show archive/shopify-connector:lib/shopping.ts`. `emitStockSyncSkipLog` survives:
the WooCommerce arm calls it directly.

## One latent crash fixed on the way out

`handleShoppingWebhook`'s "plugin is disabled" refusal built its message with
`getShoppingConnector(connector).label`, and `getShoppingConnector` **throws** on an id it does not
know. So the one branch whose job is to refuse an unrecognised connector would have answered 500
instead of 423. It could not be reached before (both ids were registered); it became reachable the
moment the id union shrank, and the test that drives it found it immediately. The label is now
resolved defensively from `SHOPPING_CONNECTORS` with the raw id as a fallback.

## Two gaps closed by removal rather than by fixing

- **`tests/security/setting-secret-read-authorization.test.ts`** carried an explicit
  `'app/actions/shopping-sync.ts': 'OUT OF SCOPE (Shopify)'` waiver: the file masked
  `shopify_admin_api_access_token` and `shopify_webhook_secret` without routing them through the
  `maskSettingSecret` gate. That file no longer masks anything, and the waiver is deleted (the
  surrounding assertion is exhaustive, so a stale waiver fails it).
- **The maintenance-mode fence.** `app/api/backup/restore/route.ts` named "a `shopify` delivery to
  the shopping webhook route" as the one shopping ingress maintenance mode does **not** fence.
  Every delivery this build can accept is now fenced — by `handleWcWebhook`, not by the route. The
  classification stays `woocommerce-only` rather than becoming `yes` for exactly that reason: the
  route file itself still does not consult the flag, so the next connector registered here is
  unfenced by omission unless its own handler consults it.

## What was KEPT, and why

- **The thirteen `switch (connector)` dispatches in `lib/shopping.ts`, each now with one arm.** They
  read as pointless and they are not: they are the list of ports a second storefront has to answer,
  they are exhaustive over the id union, and so adding an id to `SHOPPING_CONNECTORS` turns every
  unanswered port into a `tsc` error. Collapsing them into direct WooCommerce calls would delete
  that list, and re-deriving it would mean re-reading every caller. The file's header says this.
- **Two explicit default-deny returns, newly WRITTEN rather than implied.** Shopify's arms *were*
  the "this connector cannot do that" answer in `handleShoppingWebhook` and
  `isEmptyShoppingWebhookBodyAllowed`. Removing them left both switches falling off their end and
  returning `undefined` — falsy, so the callers happened to behave the same, which is exactly the
  kind of accident that stops being true the first time somebody writes `=== false`. Both now
  answer explicitly (a named 501, and `false`).
- **`WEBHOOK_ORIGIN_NOT_APPLICABLE`** — Shopify was the only production writer that omitted an origin
  attestation. The constant stays; it now has no live producer.
- **The `lib/jobs/shopping/` ↔ `lib/jobs/woocommerce/` split.** With one connector left,
  `lib/jobs/shopping/process-shopping-webhook-events.ts` has exactly one caller. It is kept because
  it is genuinely parameterised over the connector (the contract test drives it with a fictitious
  id), not because it is currently shared — and that is stated here rather than assumed.
- **`handleShoppingWebhook`'s default-deny for a plugin that is off.** Statically unreachable today;
  see "What is no longer proven".
- **The registry, the parser, the prefix reader and the per-connector route ingress.** All still
  driven by `SHOPPING_CONNECTORS`. Two ingress routes that spelled their own
  `'woocommerce' | 'shopify'` union (`app/api/shopping/manual-sync`,
  `app/api/shopping/[connector]/invoice-pdf`) were changed to derive their predicate from the
  registry instead — removing a duplicate id union rather than narrowing it.

## What is no longer proven

This is the honest cost of going from two shopping connectors to one. Each item is a place where a
test that used to distinguish "generic" from "WooCommerce with extra steps" can no longer do so.

1. **`SHOPPING_CONNECTORS.length >= 2`** in `tests/connectors/shopping-contract.test.ts` is now
   `>= 1`. That assertion was the ONE place the shipped registry was proved to be genuinely
   multi-entry. With one entry, "the ingress is registry-driven" and "the ingress hardcodes
   WooCommerce" produce identical results. **Do not restore it with a fixture entry** — a registry
   the app does not ship is not the registry the ingress reads.
2. **Nothing routes a second id through the thirteen dispatches.** The contract test still drives a
   fictitious `'newshop'` through the persist and process CORES (which take the connector as a
   parameter and would fail if either grew a `=== 'woocommerce'` branch), but no test can enter the
   facade with a second id, because no second id exists. The genericity of `lib/shopping.ts` is
   **type-checked, not tested**.
3. **The commerce-pair exclusivity race** (`tests/accounting/plugin-selection-lock.test.ts`) is
   deleted with its group. It was the evidence that the selection lock is about the SHAPE of the id
   space rather than about the accounting pair somebody remembered. What remains is "EVERY plugin key
   is locked, in one canonical order", which proves the lock SET is the whole registry but not that a
   second group is enforced.
4. **The route-level empty-body rule for a non-WooCommerce connector** is gone from
   `tests/security/shopping-webhook-body-safety.test.ts`. The route resolves its connector through
   `parseShoppingConnectorId`, which now 404s every id but `woocommerce` before the body rule is
   reached. The RULE is still covered one layer down, directly, in
   `tests/connectors/shopping-webhook-empty-body.test.ts`.
5. **Three default-deny tests now use an unregistered id rather than a second registered one**
   (`shopping-webhook-empty-body`, `shopping-dispatcher-disabled-persist`,
   `security/shopping-invoice-pdf`). They lock that the code answers explicitly for an id it does not
   recognise — which is a real and useful property, and a weaker subject than a second shipped
   connector. The casts are deliberate and commented at each site.
6. **`parseShoppingConnectorId`'s explicit-fallback case cannot distinguish anything**: with one
   registered id, the only legal argument IS the default. Kept, marked, and not to be read as
   coverage.
7. **`persistWcWebhookEvent` is the only connector-specific persist wrapper left**, so the test that
   compared two wrappers now shows only that one of them names its own connector. A core that
   hardcoded `'woocommerce'` would still pass it; the core is covered separately with `'newshop'`.

## Data left behind (development databases only; production is unused and will be reinstalled)

**No migration was authored and no database is altered by this branch.**

- `shopping_webhook_events` rows with `connector = 'shopify'` become unprocessable: the cron no
  longer has a Shopify tick, and `scheduleInboxDrain` no longer has a `shopify` drainer. **Decision:
  leave them.** The column is a plain `String`, so nothing refuses to read them; they are inert rows
  in an inbox, they were already permanently failing (the drainer marked every event `FAILED`), and
  deleting rows to tidy up a dev database is a worse habit than leaving visibly stale ones. They age
  out under the ordinary webhook-event retention window.
- `Setting` rows `shopify_*` and `plugin_shopify_enabled` become orphans. **Decision: leave them.**
  Nothing reads them, `getIntegrationPluginState` is built over the id union so it cannot see
  `plugin_shopify_enabled` at all, and a settings-row delete is not worth a migration on a database
  that is about to be reinstalled. They are visible in Settings' raw setting list, which is the
  correct amount of visibility for an orphan.
- `ShoppingSyncLog` rows with `connector = 'shopify'` are unreachable from the UI (the reader is
  keyed by registered connector). **Decision: leave them**, same reasoning.

If a future install wants them gone, a `DELETE FROM settings WHERE key LIKE 'shopify\_%'` is safe and
needs no code change — but it is not something this branch does on anyone's behalf.
