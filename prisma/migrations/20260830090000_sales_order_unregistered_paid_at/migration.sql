-- o3d-psrx r2 — WHERE THE PAID FLAG CAME FROM, recorded rather than inferred.
--
-- `sales_orders.paidAt` says the order is held as paid. It does not say whether the LEDGER said so
-- (the Xero/QuickBooks forward pass, the backlog reconcile) or whether a CHANNEL or an OPERATOR did
-- (the WooCommerce importer's `date_paid_gmt`, `markSalesOrderPaid`). The payment poller's reversal
-- pass reads a zero-paid ledger invoice as a removal, which is right for the first and catastrophic
-- for the second: nothing was ever registered, so the ledger's zero is IMS's own silence, and acting
-- on it clears `paidAt` and raises a chargeback credit note against a sale that really was paid.
--
-- Nullable, no default: NULL means "no writer spoke for this row". Every writer of `paidAt` in app/
-- and lib/ now names this column in the SAME `data` object, so the two commit together.
ALTER TABLE "sales_orders" ADD COLUMN "unregistered_paid_at" TIMESTAMP(3);

-- THE POPULATION THIS BACKFILL CAN PROVE, and only that one.
--
-- Every ledger-sourced writer of a sales `paidAt` — lib/connectors/xero/payment-poller.ts (forward
-- pass), lib/connectors/xero/payment-reconcile.ts, lib/connectors/quickbooks/payment-poller.ts —
-- selects with `shoppingLinks: { none: {} }`. A SHOPPING-LINKED order's `paidAt` therefore CANNOT
-- have come from the ledger; it came from the channel importer, from `markSalesOrderPaid`, or from
-- `addPayment`. The first two are exactly what this column exists to mark, and the third is
-- excluded below by requiring that no non-refund `Payment` row exists (a local receipt is already
-- witnessed by o3d-psrx r1 and needs no marker).
--
-- Orders with NO shopping link are left NULL: a hand-marked one and a ledger-detected one are
-- indistinguishable in the schema, and guessing either way would be worse than saying nothing. They
-- are covered going forward by the writers themselves.
--
-- Idempotent: re-running it changes nothing already stamped, so it is safe to repeat if a
-- predecessor binary served across the deploy window and stamped `paidAt` without this column.
UPDATE "sales_orders" AS so
SET "unregistered_paid_at" = so."paidAt"
WHERE so."paidAt" IS NOT NULL
  AND so."unregistered_paid_at" IS NULL
  AND EXISTS (SELECT 1 FROM "shopping_order_links" sol WHERE sol."orderId" = so."id")
  AND NOT EXISTS (
    SELECT 1 FROM "payments" p WHERE p."orderId" = so."id" AND p."refundId" IS NULL
  );
