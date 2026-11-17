-- Additive: the invoicing dimension of a sales order (not / partially / fully invoiced), orthogonal to the fulfilment status, like
-- RefundDisposition. A new enum and one NOT NULL column with a constant default (PostgreSQL adds it without rewriting the table).
CREATE TYPE "InvoicingState" AS ENUM ('NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED');

ALTER TABLE "sales_orders" ADD COLUMN "invoicing_state" "InvoicingState" NOT NULL DEFAULT 'NOT_INVOICED';

-- INITIAL VALUE, so a stored value is never wrong on an existing database. The rule is deliberately CONSERVATIVE: it marks an order
-- FULLY_INVOICED exactly when lib/domain/sales/invoicing-state.ts would find invoice evidence, and it does not try to detect a PARTIAL
-- (which needs the stored invoice lines against the order's lines): `npm run sales:invoicing-state:recompute` refines that, and so does
-- the next write to the order's invoice. The evidence, each one sufficient:
--   1. the accounting invoice is linked to the order (accounting_invoice_id);
--   2. an invoice sync row (SALES_INVOICE / SALES_INVOICE_UPDATE) for the order is queued or posted (PENDING, PROCESSING, SYNCED), or
--      names a document (a non-empty externalTransactionId, in any status). A shadow is CANCELLED with no document id, so it is not evidence;
--   3. the incumbent's invoice number is on the order and the order is linked to WooCommerce (the connector that supplies the number).
-- Deterministic and idempotent; it only ever sets rows that are still at the default.
UPDATE "sales_orders" so
SET "invoicing_state" = 'FULLY_INVOICED'
WHERE so."invoicing_state" = 'NOT_INVOICED'
  AND (
    so."accounting_invoice_id" IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM "accounting_sync_logs" l
      WHERE l."referenceType" = 'SalesOrder'
        AND l."referenceId" = so."id"
        AND l."type"::text IN ('SALES_INVOICE', 'SALES_INVOICE_UPDATE')
        AND (l."status"::text IN ('PENDING', 'PROCESSING', 'SYNCED') OR COALESCE(BTRIM(l."externalTransactionId"), '') <> '')
    )
    OR (
      COALESCE(BTRIM(so."invoiceNumber"), '') <> ''
      AND EXISTS (SELECT 1 FROM "shopping_order_links" k WHERE k."orderId" = so."id" AND k."connector" = 'woocommerce')
    )
  );
