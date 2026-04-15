# WooCommerce Follow-Up Plan

Date: 2026-04-15
Branch baseline: `main`

## Goal

Close the remaining WooCommerce follow-up items after the webhook-first shift for orders and products, while keeping the shopping connector boundary replaceable for a future Shopify connector.

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

Still open / partial:
- IMS does not yet push tracking metadata back to WooCommerce.
- Stock sync still uses its own immediate push + retry-drain model rather than a documented webhook-first narrative across all sync categories.
- Backup reconciliation behavior exists, but the cron split and naming can still be clarified further.
- There is no dedicated live E2E coverage for outbound tracking sync because that connector behavior is not implemented yet.

## Work items

### 1. Implement outbound IMS → WooCommerce tracking sync

Problem:
- IMS can store shipment/order tracking, but the WooCommerce connector currently only pushes order status outbound.
- WooCommerce tracking is only read inbound from order meta; there is no outbound write path.

Required changes:
- Decide the target integration shape:
  - write the shipment-tracking plugin meta directly, or
  - call a dedicated plugin/API endpoint if one exists on the store.
- Add a WooCommerce connector function for tracking writes.
- Trigger it from the IMS shipment/order shipping flow when tracking is added or changed.
- Ensure idempotent updates so re-saving tracking does not create duplicate tracking entries upstream.
- Add activity/wc sync logs so failed tracking pushes are diagnosable.

Questions to resolve:
- Which stage/live WooCommerce tracking plugin is the system of record?
- Does the store expect one tracking entry per shipment or one per order?
- Should carrier normalization happen in IMS or in the WooCommerce connector layer?

Definition of done:
- Adding or editing tracking in IMS writes the expected tracking data to the linked WooCommerce order.
- Repeating the same update is safe.
- Failures are visible in logs and recoverable.

### 2. Harden echo suppression for tracking and stock-adjacent webhook loops

Problem:
- Product stock webhook suppression exists, but outbound tracking sync will create a new loop risk once implemented.

Required changes:
- Reuse or extend the current webhook echo-suppression strategy for tracking writes.
- Document which webhook topics are authoritative inbound signals versus reflections of IMS-originated pushes.
- Verify that outbound writes do not cause duplicate shipment/order mutations inside IMS.

Definition of done:
- IMS-originated tracking pushes do not bounce back into duplicate IMS updates.
- Suppression behavior is explicit and observable.

### 3. Clarify the final WooCommerce cron shape

Problem:
- The architecture is now webhook-first, but operators still need a crisp mental model for what the remaining WooCommerce cron jobs do.

Required changes:
- Review the remaining WooCommerce-related cron endpoints and responsibilities:
  - order/product reconciliation
  - stock retry draining
  - any other WooCommerce-specific maintenance
- Decide whether `wc-sync` compatibility can be removed entirely after rollout.
- Keep backup reconciliation infrequent by default, ideally daily.
- Keep stock retry draining separate if it still needs a higher-frequency worker cadence.

Definition of done:
- There is a clear split between:
  - real-time webhook/on-demand sync
  - backup reconciliation
  - retry draining / maintenance
- Cron naming and settings copy match that model exactly.

### 4. Expand live and automated E2E coverage

Problem:
- Live scoped validation was done manually and proved key paths, but it is not yet captured as a repeatable test plan.

Required changes:
- Add a documented manual runbook for live scoped stage tests:
  - create/update product in WC and force only the generated IMS webhook
  - create/update order in WC and force only the generated IMS webhook
  - push product metadata from IMS to WC and verify the stage product
  - once implemented, add IMS → WC tracking verification
- Add automated test coverage where practical for:
  - WC webhook status updates
  - product metadata push
  - tracking push

Definition of done:
- We have both:
  - an operator-friendly live verification checklist, and
  - regression coverage for the non-live connector logic.

### 5. Preserve connector replaceability for future Shopify support

Problem:
- WooCommerce-specific logic is still reasonably contained, but future changes could easily leak connector-specific assumptions back into core flows.

Required changes:
- Keep core app code importing shopping behavior through `lib/shopping.ts` or equivalent connector facades.
- Avoid adding WooCommerce-specific meta formats or REST payload assumptions directly in generic sales/inventory actions.
- When implementing tracking push, keep the core event as “update external delivery metadata” and leave WooCommerce-specific payload shape inside the connector module.
- Document any remaining places where WooCommerce types still leak across the boundary and clean them up incrementally.

Definition of done:
- New WooCommerce work does not make Shopify replacement harder.
- Connector-specific payloads stay inside `lib/connectors/woocommerce`.

## Suggested order

1. Outbound IMS → WooCommerce tracking sync
2. Tracking/stock echo suppression hardening
3. Cron-shape cleanup and operator model
4. Live/automated E2E expansion
5. Connector-boundary cleanup where needed

## Suggested next-session starting checklist

1. Re-read `docs/WC-followup-plan.md`.
2. Identify the exact WooCommerce tracking plugin/API used on stage/live.
3. Inspect how tracking data is currently stored on WooCommerce orders.
4. Implement outbound tracking sync first, because it is the largest remaining functional gap proven by live testing.
