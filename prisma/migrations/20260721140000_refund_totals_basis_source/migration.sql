-- o3d-n8p: persist what a refund's stored totals mean (totals_basis) and which trusted writer created it
-- (source), so classification is a lookup rather than a reconstruction and the o3d-w00 net ceiling/status
-- can be enabled SAFELY. Nullable + additive: a NULL totals_basis is a legacy refund whose totals are
-- GROSS. The net ceiling is applied only when every refund on an order is 'NET'; otherwise it falls back
-- to the gross basis, so a mixed legacy-gross + new-net order can't be marked fully refunded early.
ALTER TABLE "sales_order_refunds" ADD COLUMN "totals_basis" TEXT;
ALTER TABLE "sales_order_refunds" ADD COLUMN "source" TEXT;
