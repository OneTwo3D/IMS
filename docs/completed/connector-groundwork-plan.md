# Connector Groundwork Plan

## Goal

Prepare the codebase for:

- parallel shopping connectors running at the same time
- future Shopify implementation without another database reshaping pass
- future QuickBooks implementation without another database reshaping pass
- removal of early single-connector assumptions rather than preserving temporary compatibility-only patches

This groundwork should leave WooCommerce and Xero functional during development, but the design target is the final generic model, not a legacy-preserving intermediate.

## Future Plan Items

### Mintsoft integration

Add a future Mintsoft WMS connector as an optional integration plugin with no further core fulfillment rewiring required.

Design target:

- Mintsoft links to IMS sales orders by the WooCommerce order number / external order reference.
- Mintsoft can poll and translate warehouse statuses such as awaiting picking, picking started, picked, packed, and despatched.
- Mintsoft does not dispatch stock directly in bespoke connector code. Instead it calls the shared external-fulfillment entry point used by WooCommerce completion handling.
- The core app remains shipment-first:
  - sales orders are the commercial layer
  - shipments are the fulfillment layer
  - stock movement only happens from shipment lines
- The legacy direct order-level shipping path is removed from the target design. External systems must drive shipment status, not order status.
- When the Mintsoft plugin is disabled, none of the core fulfillment code needs to change.

Current shared fulfillment contract:

```ts
type ExternalFulfillmentSource = 'woocommerce' | 'shopify' | 'mintsoft'
type ExternalShipmentStatus = 'PENDING' | 'PICKING' | 'PACKED' | 'SHIPPED'

type ExternalFulfillmentLookup =
  | { orderId: string }
  | { externalOrderId: number }
  | { externalOrderNumber: string }
  | { orderNumber: string }

type ExternalFulfillmentUpdate = {
  source: ExternalFulfillmentSource
  lookup: ExternalFulfillmentLookup
  targetShipmentStatus: ExternalShipmentStatus
  tracking?: Array<{ trackingNumber: string; shippingService?: string | null }>
}
```

Behavioral expectations for the Mintsoft plugin:

- resolve the IMS order through the shared lookup rules rather than a Mintsoft-only link table
- request shipment progression via `applyExternalFulfillmentUpdate(...)`
- allow the shared layer to auto-allocate and create shipments if they do not exist yet
- pass despatch tracking in the `tracking` payload instead of writing shipment rows directly
- stay idempotent when the same warehouse status is received multiple times

## Constraints

- The system is not live yet, so schema and internal variable breaks are acceptable if they move the codebase to the correct long-term shape.
- Avoid database structures that would require another migration when Shopify or QuickBooks are implemented fully.
- Multiple shopping connectors must be able to exist and run in parallel.
- Current WooCommerce and Xero implementations should be migrated onto the new generic foundations instead of keeping connector-specific one-off paths where practical.
- Connector implementation decisions should be based on the current official Shopify and QuickBooks APIs, not on WooCommerce/Xero symmetry assumptions.

## Rollout / Backout

- The migration path should be staged inside the branch, not as one irreversible cutover with no recovery point.
- Phase 1 is additive and introduces the connector-scoped schema, link tables, and registries.
- Phase 2 and Phase 3 move WooCommerce/Xero runtime code onto the new model.
- Legacy shopping external-id columns stay available only until the refactor paths are verified locally. They are not part of the target architecture and must not receive new generic behavior.
- Cleanup and removal of no-longer-needed legacy columns happens only after type-check, Prisma regeneration, and targeted Woo/Xero verification pass in the same branch.
- Backout strategy for this pre-live environment is operational rather than compatibility-oriented:
  - take a database snapshot before applying the migration, or
  - reset and reseed the development database if the branch proves invalid

## Vendor API Constraints

### Shopify

- Use the GraphQL Admin API as the primary implementation target.
- Do not design around Shopify REST Admin as the long-term interface; Shopify documents REST Admin as legacy and requires GraphQL Admin for new public apps.
- Order import is available, but historical reads require the `read_all_orders` scope in addition to the standard order scopes.
- Inventory is available through inventory objects and quantity adjustment mutations.
- Fulfilment and delivery tracking are available, but the model is `Order` + `FulfillmentOrder` + `Fulfillment`, not a WooCommerce-style single order-status write path.
- Webhooks are first-class and app-scoped.

### QuickBooks

- OAuth 2.0, webhooks, chart of accounts, customers/vendors, items, invoices, bills, journal entries, payments, vendor credits, credit memos, and tax codes are all available through the QuickBooks Online API.
- QuickBooks requires referenced entities such as accounts, tax codes, customers, vendors, and items to exist before many transactions can be created.
- The connector must therefore support pre-sync / lookup flows for referenced entities instead of assuming Xero-style on-demand creation everywhere.
- QuickBooks inventory behavior is available, but inventory support depends on the connected company configuration and is not a substitute for IMS stock control.

## Target Architecture

### 1. Connector Registries

Introduce explicit registries for both connector families:

- shopping: `woocommerce`, `shopify`
- accounting: `xero`, `quickbooks`

These registries should define:

- connector id
- display label
- plugin setting key
- availability flag
- connector category
- numbering key namespace
- credential key namespace
- whether the connector is currently implemented for runtime dispatch

The rest of the app should refer to connector ids via shared types, not ad hoc string unions spread across files.

### 2. Parallel-Safe Shopping Identity Model

Current single-column external ids on `Product`, `Customer`, and `SalesOrder` are not sufficient for multiple shopping connectors in parallel.

Replace that assumption with connector-scoped link tables:

- `ShoppingProductLink`
- `ShoppingCustomerLink`
- `ShoppingOrderLink`

Each link table should store:

- local entity id
- connector id
- external id as string
- optional external reference / number where relevant
- optional metadata payload
- created / updated timestamps

Required uniqueness:

- unique per `(connector, externalId)`
- unique per `(connector, localEntityId)`

This makes the external identity model generic enough for WooCommerce, Shopify REST ids, and Shopify GraphQL/global ids if needed later.

Clarification for storefront refunds and child records:

- `ShoppingOrderLink` is the canonical link between one IMS sales order and one storefront order per connector.
- Refunds, fulfillments, notes, and similar child records are not represented as additional order links.
- Refund connector ids stay in refund-specific data/log structures, so the `(connector, localEntityId)` uniqueness on `ShoppingOrderLink` remains valid.

### 3. Connector-Scoped Sync and Mapping Model

These tables must be made connector-aware:

- `ShoppingSyncLog`
- `ShoppingTaxRateMapping`
- `ShoppingStatusMapping`
- `AccountingAccount`
- `AccountingSyncLog`
- `AccountingToken`

Design rules:

- every row is explicitly scoped by `connector`
- uniqueness is composite with `connector`
- shopping/accounting external ids should be string-capable where future connectors may require it

Specific changes:

- `ShoppingTaxRateMapping.externalTaxRateId` becomes string-capable and connector-scoped
- `ShoppingStatusMapping.externalStatus` becomes connector-scoped
- `AccountingAccount.externalAccountId` becomes connector-scoped
- `AccountingToken` becomes one token record per accounting connector
- `AccountingSyncLog` gets connector scope for queue/history separation

Queue rule:

- Any job-queue or retry table that doubles as execution state must be connector-scoped at row level, even if the cron entry point stays family-specific for now.

### 4. Shared Facades

Refactor the shared facades so they model the final architecture:

- `lib/shopping.ts`
- `lib/accounting.ts`

They should support:

- listing enabled connectors by family
- listing configured connectors by family
- listing runnable connectors by family
- resolving connector info from registries
- dispatching to connector modules by id
- aggregating outbound shopping work across all runnable shopping connectors

The code should stop assuming:

- shopping always means WooCommerce
- accounting always means Xero

Default / primary connector selection is allowed only as a UI convenience. It must not be the only data path.

### 5. Connector Contracts

Define explicit TypeScript contracts for connector modules.

- `ShoppingConnector`
- `AccountingConnector`

The skeleton modules and real modules should implement the same contracts so “same style of entry points” is not ambiguous.

### 6. Connector Skeleton Modules

Add empty connector skeletons that match the target structure:

- `lib/connectors/shopify/`
- `lib/connectors/quickbooks/`

The skeletons should include the module boundaries expected by future work:

- settings
- auth where relevant
- accounts where relevant
- orders / products / links / delivery where relevant
- queue / sync processor where relevant
- index exports

These should return explicit “not implemented” results, not dead imports or placeholder comments only.

### 7. Credential Model

Credential storage must be decided up front.

- Database-backed settings are the source of truth for shopping/accounting connector configuration.
- Connector tokens that are part of OAuth flows remain in dedicated token tables when appropriate, but they are connector-scoped.
- Environment variables are allowed only as local bootstrap / secret fallback paths where already present; they are not the canonical multi-connector storage model.
- New connectors should receive namespaced settings keys from the start.

### 8. Webhook Routing

Webhook ingress must be connector-aware by path.

- Use connector-specific route trees such as `/api/webhooks/shopping/[connector]/[resource]`.
- WooCommerce and Shopify should not share a single auto-dispatch webhook endpoint selected by “active connector”.
- Shared facades may validate connector ids and dispatch, but the HTTP route shape itself must preserve connector identity.

### 9. Queue / Cron Routing

- Shopping execution state lives in connector-scoped rows.
- Cron entry points may remain connector-specific while implementations are still uneven.
- The long-term target is family-level orchestration that iterates runnable connectors, but the runtime must never infer connector ownership from non-scoped rows.

### 10. UI / Plugin Groundwork

Expand plugin and integration UI plumbing so the new connectors exist cleanly in the system:

- plugin state includes `shopify` and `quickbooks`
- system plugin settings can enable / disable them
- sync dashboard can render dormant skeleton cards or placeholder connector views for them
- module visibility rules consider either accounting connector and any enabled shopping connector

The UI should not imply the connectors are fully implemented, but it should recognize them as first-class connectors.

### 11. Environment / Provisioning

Update:

- `.env.example`
- provisioning templates and fresh install docs
- any setup docs that mention only WooCommerce/Xero credentials

The documentation should make clear which values are DB settings, which are OAuth app credentials, and which env vars are only bootstrap fallbacks.

## Implementation Phases

### Phase 1. Schema Redesign

Update Prisma schema to:

- add connector registries/types support in code
- add `ShoppingProductLink`
- add `ShoppingCustomerLink`
- add `ShoppingOrderLink`
- add connector columns to sync/mapping/accounting tables
- replace single-column unique assumptions with connector-scoped unique constraints

Legacy external-id fields on core models are not part of the target architecture.

- New connector work must use link tables only.
- Existing WooCommerce runtime paths may continue to read/write the legacy fields only until Phase 3 is complete.
- Cleanup removal happens in the final cleanup phase of this same branch, not as an undefined future migration.

### Phase 2. Data Migration

Create a migration that:

- backfills WooCommerce product/customer/order identities into the new shopping link tables
- backfills connector values into existing sync and accounting tables
- migrates Xero token/account/log records to connector-scoped rows
- converts tax-rate mappings into connector-scoped rows

Migration must be deterministic and safe for a pre-live environment.

Operational requirement:

- take a DB snapshot before migration or be prepared to reset/reseed the development database if validation fails

### Phase 3. Core Code Refactor

Refactor current Woo/Xero code to use the new schema:

- WooCommerce order lookup/import paths use `ShoppingOrderLink`
- WooCommerce customer matching uses `ShoppingCustomerLink`
- WooCommerce product mapping uses `ShoppingProductLink`
- WooCommerce tax/status mapping queries scope by connector
- Xero token/account/log queries scope by connector

This phase removes the most important single-connector assumptions rather than hiding them under compatibility aliases.

### Phase 4. Registries and Shared Connector APIs

Add:

- `lib/connectors/accounting-registry.ts`
- extend `lib/connectors/shopping-registry.ts`
- central connector id types if needed

Then update:

- `lib/integration-plugins.ts`
- `lib/shopping.ts`
- `lib/accounting.ts`
- shared action wrappers in `app/actions/shopping-sync.ts` and `app/actions/accounting-sync.ts`

Target outcome:

- shared code can identify connectors generically
- shared code can aggregate shopping writes across multiple runnable connectors
- shared code can keep using Woo/Xero as the only fully implemented handlers for now
- the dispatch shape is final enough that Shopify/QuickBooks implementation can slot in later without another API redesign

### Phase 5. Skeleton Connectors

Create structured but empty connector modules for:

- Shopify shopping connector
- QuickBooks accounting connector

Each skeleton should:

- export the same style of entry points as the real connectors
- implement the shared connector contracts
- compile cleanly
- return explicit “not implemented” errors

### Phase 6. Webhooks / Queue Routing

Update:

- webhook route structure to include connector identity
- webhook registration helpers
- cron / queue processors so connector ownership is explicit

### Phase 7. UI Groundwork

Update:

- plugin settings UI
- system settings page data flow
- sync dashboard visibility/filtering
- placeholder views for Shopify and QuickBooks

Goal:

- the app recognizes the connectors
- the user can enable them
- the UI communicates that implementation is pending

### Phase 8. Verification

Run:

- Prisma generate
- TypeScript type-check
- targeted lint if needed

Then inspect:

- any remaining direct assumptions that WooCommerce/Xero are the only possible connectors
- any remaining uniqueness constraints that would block multiple shopping connectors
- backfilled shopping/customer/order link rows
- connector-scoped accounting rows and token reads
- webhook route paths and signature verification still working

Manual verification minimum:

- WooCommerce order import still works end-to-end after link-table migration
- WooCommerce product/stock sync still works after connector-scoped log changes
- WooCommerce webhook registration now points at connector-specific routes
- Xero connect, token refresh, account sync, and at least one posting path still work
- migration backfill queries show expected row counts for product/customer/order links

## Files Expected To Change

### Schema / Data

- `prisma/schema.prisma`
- new migration under `prisma/migrations/`

### Shared Connector Plumbing

- `lib/integration-plugins.ts`
- `lib/shopping.ts`
- `lib/accounting.ts`
- `lib/connectors/shopping-registry.ts`
- `lib/connectors/accounting-registry.ts` (new)
- `lib/connectors/types.ts`
- webhook route files under `app/api/webhooks/shopping/`
- optional shared connector-id helper file

### WooCommerce / Xero Refactor Targets

- `lib/connectors/woocommerce/...`
- `lib/connectors/xero/...`
- `app/actions/wc-sync.ts`
- `app/actions/xero-sync.ts`
- `app/actions/shopping-sync.ts`
- `app/actions/accounting-sync.ts`
- `app/actions/reset.ts`

### UI

- `components/settings/integration-plugins-settings.tsx`
- `app/(dashboard)/settings/system/page.tsx`
- `app/(dashboard)/sync/page.tsx`
- `app/(dashboard)/sync/sync-dashboard.tsx`

### New Skeletons

- `lib/connectors/shopify/...`
- `lib/connectors/quickbooks/...`

## Non-Goals For This Groundwork Pass

- full Shopify business logic
- full QuickBooks business logic
- final Shopify webhook processing
- final QuickBooks OAuth/account sync implementation
- full multi-connector UX for choosing a connector per operation

Those come later. This groundwork only ensures the database and shared code shape do not need another architectural reset.

## Success Criteria

This pass is successful when:

- the database can represent multiple shopping connectors in parallel
- connector-specific sync/mapping/accounting tables are connector-scoped
- WooCommerce and Xero are migrated onto the new generic schema shape
- Shopify and QuickBooks skeleton modules exist and compile
- plugin/UI plumbing recognizes Shopify and QuickBooks
- future Shopify and QuickBooks implementation should not require another schema redesign
