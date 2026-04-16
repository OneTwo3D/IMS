# Shopify Connector Follow-Up Plan

This file tracks the shared and non-connector work that should happen after the connector-owned Shopify implementation.

## Shared shopping facade

- Done: Shopify webhook requests now pass the real `request` and `resource` into `lib/connectors/shopify/handleWebhook(...)`.
- Done: `lib/shopping.ts` no longer leaves Shopify as a no-op for:
  - `enqueueStockSync(...)`
  - `pushProductMetadata(...)` (currently treated as an intentional skip until product push is implemented)
  - `pushOrderDeliveryMetadata(...)` (currently treated as an intentional skip until fulfillment write-back is implemented)
  - `hasExternalProductLink(...)`
- Decide whether the shared facade should expose Shopify cursor-based pagination explicitly instead of flattening it into the current Woo-shaped return shape.

## Actions and sync workflows

- Done: `app/actions/shopping-sync.ts` now has Shopify-specific settings, credentials, logs, and manual stock-sync actions alongside the WooCommerce actions.
- Add Shopify-specific sync job entrypoints for:
  - product push
  - stock push
  - order import
  - webhook-triggered delta sync
- Define the long-term queue ownership model for multiple shopping connectors running in parallel.

## Connector activation and settings UX

- Done: Shopify is now marked available in `lib/connectors/shopping-registry.ts`.
- Done: the Sync UI now has a Shopify settings form for domain/token/webhook secret and manual stock sync.
- Add connector-specific guidance for required Shopify scopes:
  - `read_products`
  - `read_inventory`
  - `write_inventory`
  - `read_orders`
  - `read_all_orders` if historical imports must reach beyond 60 days

## Webhook routing and processing

- Keep Shopify on its own route tree; do not collapse it into a shared “active shopping connector” webhook endpoint.
- Add topic-aware webhook processing for at least:
  - `orders/create`
  - `orders/updated`
  - `orders/cancelled`
  - `refunds/create`
  - `products/update`
- Add webhook idempotency storage keyed by Shopify webhook/event ids if repeated delivery becomes an issue.

## Inventory and fulfillment design

- Add explicit Shopify location mapping before enabling stock sync for multi-location stores.
- Add Shopify fulfillment creation / tracking update support before the shared `pushOrderDeliveryMetadata(...)` branch is enabled.
- Decide how Shopify refunds and split fulfillments should map into the IMS order/refund model.

## Verification

- Run end-to-end tests against a real Shopify development store after the shared wiring is finished.
- Verify webhook signature handling with real HTTPS payloads.
- Verify stock sync on:
  - a single-location store
  - a multi-location store
- Verify historical order import with and without `read_all_orders`.
