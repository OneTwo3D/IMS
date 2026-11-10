-- Tax rates: the zero-rated Xero tax type a scheme (IOSS/VOEC) sale posts on.
--
-- One nullable column, no default, on a table the previous build reads and writes by named columns. Safe while the previous build
-- serves: it never reads or writes the column, and NULL (the value on every existing row) means "not sold under a scheme".
ALTER TABLE "tax_rates" ADD COLUMN "scheme_posting_tax_type" TEXT;
