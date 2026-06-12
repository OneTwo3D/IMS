-- Prepaid / deposit supplier flag. Relaxes the purchase-invoice three-way
-- match control (bill <= received qty) to the ordered quantity for this
-- supplier's POs. Boolean with a constant default → no table rewrite.
ALTER TABLE "suppliers" ADD COLUMN "prepaid" boolean NOT NULL DEFAULT false;
