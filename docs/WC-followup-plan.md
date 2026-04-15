# WooCommerce Follow-Up Plan

Date: 2026-04-15
Branch baseline: `main`

## Goal

Close the WooCommerce follow-up work after the webhook-first shift for orders and products, and finish the connector-boundary refactor needed so WooCommerce can be disabled or replaced by a different shopping connector without changing non-connector code.

## Outcome

Status as of 2026-04-15:
- The originally planned follow-up implementation work is complete.
- WooCommerce order and product intake is webhook-first.
- `/api/cron/wc-reconcile` is the documented backup reconcile endpoint and also drains queued stock retry jobs.
- `/api/cron/wc-reconcile` is the only remaining daily WooCommerce catch-up endpoint.
- IMS now pushes tracking metadata back to WooCommerce and suppresses reflected webhook echoes.
- Live verification documentation and automated Playwright coverage both exist.

What remains is connector-boundary refactoring rather than missing functionality:
- remove remaining WooCommerce-specific imports, settings knowledge, route naming assumptions, and UI affordances from app/core code
- make the main program depend only on connector-agnostic shopping interfaces
- leave WooCommerce-specific config, payload shaping, webhook handling, and admin wiring inside the shopping connector implementation

## Current status

Already fixed:
- Orders are webhook-first, with cron acting as backup reconciliation rather than the primary intake path.
- Products are webhook-first, with cron acting as backup reconciliation rather than the primary intake path.
- The WooCommerce cron/settings UI now describes the job as backup reconciliation.
- Scoped live webhook tests proved:
  - WC → IMS product import works.
  - WC → IMS product update works.
  - WC → IMS order create works.
  - WC → IMS order update works after removing the auth-redirecting server action call from webhook status sync.
- Connector boundaries remain routed through `lib/shopping.ts` rather than hard-wiring WooCommerce calls into core flows.

Known operational caveat:
- The stage WooCommerce Action Scheduler is not auto-draining webhook delivery jobs reliably, so live validation currently requires forcing only the relevant generated action IDs. This is a stage/store infrastructure issue, not an IMS webhook-handler issue.

Current intended operating model:
- Orders: webhook-first inbound sync, with daily backup reconciliation
- Products: webhook-first inbound sync, with daily backup reconciliation
- Stock: immediate IMS-originated outbound push with queued retry draining and forced daily catch-up inside `/api/cron/wc-reconcile`
- Tracking: immediate IMS-originated outbound push with webhook echo suppression

Closed in follow-up work after this plan was written:
- IMS now pushes tracking metadata back to WooCommerce by writing AST-compatible `_wc_shipment_tracking_items` order meta through the WooCommerce connector.
- Tracking writes are triggered both when a shipment is first shipped and when shipped-shipment tracking is edited later in IMS.
- Tracking/status echo suppression now exists on WooCommerce order webhooks, so IMS-originated reflected writes are logged and skipped rather than re-mutating IMS orders.
- Automated coverage now exists for:
  - shipment tracking add/edit inside IMS, and
  - live WooCommerce tracking push verification via the external Playwright suite.

## Work items

### 1. Implement outbound IMS → WooCommerce tracking sync

Status: closed

Implemented:
- tracking writes go through the shopping connector boundary
- WooCommerce-specific payload shaping stays inside `lib/connectors/woocommerce`
- writes are idempotent and logged
- shipment-create and shipment-edit flows both trigger outbound tracking sync

### 2. Harden echo suppression for tracking and stock-adjacent webhook loops

Status: closed

Implemented:
- order webhook echo suppression now covers IMS-originated status and tracking reflections
- suppression events are logged rather than silently ignored
- automated coverage exists for the main tracking path

### 3. Clarify the final WooCommerce cron shape

Status: closed

Current model:
- real-time inbound order/product changes come from WooCommerce webhooks
- `/api/cron/wc-reconcile` performs backup reconciliation and owns the daily stock catch-up plus queued retry draining
- `/api/cron/delivery-status` remains separate for carrier polling

### 4. Expand live and automated E2E coverage

Status: closed

Implemented:
- `docs/woocommerce-live-runbook.md` captures the operator-facing live verification checklist
- Playwright coverage now covers shipment tracking edit flow and live WooCommerce tracking push verification
- route and admin coverage were expanded so the selector-driven E2E harness reaches more integration-facing surfaces

### 5. Finish the shopping connector boundary for future Shopify support

Status: open

Target architecture:
- non-connector code should know only about a generic shopping connector interface and the currently active shopping connector
- shopping-specific operations should be exposed through app-facing connector-agnostic facades
- WooCommerce-specific settings keys, webhook topics, URLs, payloads, and helper imports should remain inside the WooCommerce connector
- replacing WooCommerce with Shopify should require adding a Shopify connector implementation and changing connector selection/configuration only, not editing core business logic, routes, or shared UI

Current boundary leaks to remove:
- `lib/trackship.ts` directly imports WooCommerce delivery helpers and reads WooCommerce settings
- shared/product UI still imports WooCommerce-specific helpers for external product links
- the integrations action layer and integrations page are hard-wired to WooCommerce concepts instead of going through a generic shopping integration surface
- app routes are still named and structured as WooCommerce-specific webhook entrypoints
- some page/UI code still reads `wc_*` settings or `wc*` fields directly rather than consuming generic external-connector view models

Planned refactor phases:

Phase 1: Define the generic shopping interface
- expand `lib/shopping.ts` into the stable app-facing contract for shopping connectors
- add connector-agnostic capabilities for:
  - external product link lookup
  - external order/admin link lookup
  - delivery-status lookup for shipped orders
  - shopping integration status/config summary
  - inbound webhook dispatch
- centralize active shopping connector resolution in one place

Phase 2: Move delivery tracking status behind the connector facade
- remove direct WooCommerce imports from `lib/trackship.ts`
- replace WooCommerce-specific settings reads there with connector-agnostic delivery-status access
- keep TrackShip direct mode as a separate carrier-tracking source, but make the shopping-platform mode call only the generic shopping interface

Phase 3: Replace direct WooCommerce UI helpers with generic external-link helpers
- replace `WcLinkButton` and sales-order Woo admin link handling with generic shopping connector link actions/components
- stop reading `wc_url` directly in page code
- expose connector-provided external destination labels and URLs through the generic shopping facade

Phase 4: Generalize the shopping integrations admin surface
- replace `app/actions/wc-sync.ts` as the app-facing surface with generic shopping integration actions
- move WooCommerce-specific credential storage, webhook setup, and sync diagnostics behind connector-owned adapters
- keep the dashboard page generic, with connector-provided sections/details rendered from connector metadata

Phase 5: Generalize inbound webhook routing
- replace WooCommerce-specific app route assumptions with a generic shopping webhook entrypoint or connector registration layer
- keep signature verification, topic parsing, and payload mapping inside the connector implementation
- ensure the app router does not need new top-level business logic when a new shopping connector is added

Phase 6: Remove remaining Woo-specific reads from shared pages and models
- audit app pages/components for direct reads of `wc_*` settings, `wcSyncLog`, `wcOrderId`, `wcOrderNumber`, and similar connector-specific state
- replace them with generic external-sync state/view helpers where possible
- where persistent schema fields remain Woo-specific for migration reasons, keep them behind generic selectors/view models so page code does not bind to WooCommerce names

Acceptance criteria for this refactor:
- no non-connector code imports from `lib/connectors/woocommerce/**`, except a single generic bootstrap/registration layer if still needed
- no non-connector code reads `wc_*` settings directly
- shared UI does not use WooCommerce-specific component names or helper imports
- the active shopping connector can be changed without editing core flows, route handlers, or shared dashboard/page code
- WooCommerce-specific tests remain under WooCommerce connector coverage, while generic shopping behaviors are exercised through connector-agnostic tests

## Suggested order

Recommended next implementation order:
1. Define and freeze the generic shopping connector contract in `lib/shopping.ts`
2. Refactor `lib/trackship.ts` to remove direct WooCommerce knowledge
3. Replace WooCommerce-specific product/order link UI with generic external-link helpers
4. Introduce generic shopping integration actions and adapt the integrations dashboard to them
5. Generalize shopping webhook ingress so new connectors do not require app-level Woo-specific routes
6. Sweep remaining page/component leaks and tighten test coverage around the generic contract

## Suggested next-session starting checklist

1. Re-read `docs/WC-followup-plan.md`.
2. Start with the `lib/trackship.ts` boundary leak, because it is the clearest non-UI core violation.
3. After the delivery-status facade exists, replace WooCommerce-specific external link helpers in sales/inventory UI.
4. Then move the integrations dashboard/actions and webhook ingress onto generic shopping connector surfaces.

## Session continuation code

Use this to resume the refactor in a later session:

```text
Continue the shopping connector boundary refactor described in docs/WC-followup-plan.md.

Goal:
- make WooCommerce fully replaceable by another shopping connector without changing non-connector code

Current highest-priority leak:
- lib/trackship.ts still imports WooCommerce delivery helpers directly and reads WooCommerce settings

Required approach:
- keep non-connector code dependent only on generic shopping interfaces
- keep WooCommerce-specific settings, URLs, payload shaping, webhook handling, and admin details inside lib/connectors/woocommerce
- do not introduce new wc_* reads or direct imports from lib/connectors/woocommerce outside the generic shopping boundary

Suggested order:
1. expand lib/shopping.ts with a generic delivery-status/external-link interface as needed
2. refactor lib/trackship.ts to use that interface
3. replace WooCommerce-specific external link helpers in sales/inventory UI
4. then move shopping integration actions/dashboard and webhook ingress onto generic surfaces

Acceptance criteria:
- no non-connector code imports from lib/connectors/woocommerce/** except a generic bootstrap/registration layer if still needed
- no non-connector code reads wc_* settings directly
- shared UI does not use WooCommerce-specific helper/component names

```
codex resume 019d91b1-925e-7b80-9181-f9123e8e834a
