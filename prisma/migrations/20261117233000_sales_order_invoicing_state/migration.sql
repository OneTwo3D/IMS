-- Additive: the invoicing dimension of a sales order (not / partially / fully invoiced), orthogonal to the fulfilment status, like
-- RefundDisposition. A new enum and one NOT NULL column with a constant default: PostgreSQL adds it without rewriting the table,
-- and every existing row reads NOT_INVOICED until lib/domain/sales/invoicing-state.ts derives it (every invoice write site recomputes
-- it; scripts/recompute-invoicing-state.ts re-derives existing rows idempotently). Nothing is backfilled here on purpose: the
-- derivation reads the sync-row standing rules and the invoice payloads, which are single-sourced in TypeScript, and a SQL copy of
-- them would be a second definition that could drift from the first.
CREATE TYPE "InvoicingState" AS ENUM ('NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED');

ALTER TABLE "sales_orders" ADD COLUMN "invoicing_state" "InvoicingState" NOT NULL DEFAULT 'NOT_INVOICED';
