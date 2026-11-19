-- Additive: the hold generation a withdrawal outcome row was written at.
ALTER TABLE "wc_withdrawal_outcomes" ADD COLUMN "hold_generation" INTEGER;
