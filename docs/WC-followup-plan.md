# WooCommerce Follow-Up Plan

Date: 2026-04-15
Branch baseline: `main`

## Goal

Close the remaining WooCommerce follow-up items after the webhook-first shift for orders and products, while keeping the shopping connector boundary replaceable for a future Shopify connector.

## Outcome

Status as of 2026-04-15:
- The originally planned follow-up implementation work is complete.
- WooCommerce order and product intake is webhook-first.
- `/api/cron/wc-reconcile` is the documented backup reconcile endpoint and also drains queued stock retry jobs.
- `/api/cron/wc-reconcile` is the only remaining daily WooCommerce catch-up endpoint.
- IMS now pushes tracking metadata back to WooCommerce and suppresses reflected webhook echoes.
- Live verification documentation and automated Playwright coverage both exist.

What remains is strategic cleanup rather than missing functionality:
- decide whether stock retry draining should eventually move to a more generic connector-owned job name when Shopify work starts
- keep watching for WooCommerce-specific assumptions leaking outside the connector boundary during future changes

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

### 5. Preserve connector replaceability for future Shopify support

Status: substantially closed, with ongoing hygiene expected

Current stance:
- core flows should continue to import shopping behavior through `lib/shopping.ts`
- WooCommerce payload/meta shaping should continue to stay inside `lib/connectors/woocommerce`
- future connector work should treat this as an ongoing guardrail, not a new dedicated follow-up project

## Suggested order

Completed order:
1. Cron-shape cleanup and operator model
2. Live/manual verification runbook
3. Stock and tracking narrative cleanup
4. Connector-boundary preservation during implementation

## Suggested next-session starting checklist

1. Re-read `docs/WC-followup-plan.md`.
2. Confirm the operator-facing docs continue to point only to `/api/cron/wc-reconcile` for WooCommerce daily catch-up.
3. Keep the stage live runbook in sync with the external Playwright coverage as webhook/store behavior evolves.
4. Revisit whether stock retry draining should eventually move behind a more generic connector-owned job name once Shopify support starts.
