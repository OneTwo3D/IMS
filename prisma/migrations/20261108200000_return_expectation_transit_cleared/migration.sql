-- Return expectations: the Stock in Transit amount that arrivals have actually JOURNALLED so far.
--
-- ADDITIVE ONLY: one column with a constant default on a table only the refund-in-transit code reads. Safe while the
-- previous build serves: it never reads or writes the column. 0 for every existing document, which is correct: no
-- arrival has journalled anything against a document before this column existed.
ALTER TABLE "return_expectations" ADD COLUMN "transit_cleared_amount" DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE "return_expectations" ADD CONSTRAINT "return_expectations_transit_cleared_amount_check" CHECK ("transit_cleared_amount" >= 0);
