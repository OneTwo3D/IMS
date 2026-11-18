-- A customs field cleared in IMS that the warehouse cannot clear through its API (or that kept failing) is raised as an open
-- discrepancy for an operator to clear by hand.
ALTER TYPE "WmsDiscrepancyCategory" ADD VALUE IF NOT EXISTS 'CUSTOMS_CLEAR_MANUAL';

-- Additive: a short compare-and-set lease on the clear marker (instead of a row lock held across the warehouse request) and a
-- per-marker attempt count (the retry cap). Existing markers start unclaimed with no attempts.
ALTER TABLE "product_customs_clears" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "product_customs_clears" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "product_customs_clears" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_customs_clears" ADD COLUMN "unverifiedAttempts" INTEGER NOT NULL DEFAULT 0;

-- The inherited-fields list is never null (the Prisma field is a non-null list); the earlier migration left the column nullable.
UPDATE "products" SET "customsInherited" = ARRAY[]::TEXT[] WHERE "customsInherited" IS NULL;
ALTER TABLE "products" ALTER COLUMN "customsInherited" SET NOT NULL;
