-- o3d-w00 #4: persist the resolved posting kind on each refund line.
--
-- The accounting RETRY loader (loadRefundAccountingQueueInput) previously re-inferred a line's kind from
-- productId and the amount sign: a null-product line was 'shipping' unless its total was negative. A
-- WooCommerce monetary-only refund creates a null-product line with lineKind='sale' and a POSITIVE total,
-- so the retry reconstructed it as 'shipping' and posted the credit-note revenue to the shipping account.
-- Persisting the kind removes the inference on retry. Nullable + additive: legacy rows carry NULL and the
-- loader keeps its historical inference, so no backfill is needed and existing behaviour is unchanged.
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "lineKind" TEXT;
