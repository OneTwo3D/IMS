-- o3d-w00: snapshot each refund line's resolved VAT identity at creation.
--
-- The credit-note poster used to re-predict a refund line's tax type from the ORDER DEFAULT rate at post
-- time. That silently mis-taxed refunds whose real rate differed from the default — a deactivated rate
-- (the order-default lookup filters active=true, so it resolved to NULL and Xero got no tax type), a
-- reverse-charged line (the per-line swap was lost on an unlinked line), and mixed-rate orders. Combined
-- with a WooCommerce monetary-only refund that stored a GROSS amount, a £120 refund posted as £120 + £24
-- VAT = £144.
--
-- Storing the identity that was actually resolved at creation removes all prediction. Nullable + additive:
-- legacy rows carry NULL and the poster refuses (rather than guesses) a line with no snapshot.
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "accountingTaxType" TEXT;
ALTER TABLE "sales_order_refund_lines" ADD COLUMN "reverseCharge" BOOLEAN;
