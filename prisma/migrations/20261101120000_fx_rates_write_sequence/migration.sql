-- Write order of an exchange-rate row, to break a fetchedAt tie: the row written later (higher seq) is the later one. Every writer of fx_rates inserts under the exclusive FX table lock, so seq
-- follows lock order.
--
-- ADDITIVE ONLY: one column with a sequence default (BIGSERIAL). Existing rows take their values in physical order, which only matters for rows that already tie on fetchedAt, and no reader depends on
-- the column except the lookup's tie-break.

-- migration-convention-ok: ADD COLUMN NOT NULL because the column is a BIGSERIAL, so it has a sequence default and every existing and future row is filled without a rewrite of any writer
-- AlterTable
ALTER TABLE "fx_rates" ADD COLUMN "seq" BIGSERIAL NOT NULL;
