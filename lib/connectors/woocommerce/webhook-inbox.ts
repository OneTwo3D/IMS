/**
 * b8i6.3: the shopping webhook-inbox repository + config helpers are
 * connector-neutral (they serve WooCommerce AND Shopify) and now live in
 * lib/connectors/shopping-webhook-inbox.ts. This module is kept as a thin
 * back-compat re-export so existing WooCommerce-side imports (and tests) keep
 * working. New code should import from '@/lib/connectors/shopping-webhook-inbox'.
 */
export * from '../shopping-webhook-inbox'
