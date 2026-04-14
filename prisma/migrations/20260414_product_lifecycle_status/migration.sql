CREATE TYPE "ProductLifecycleStatus" AS ENUM ('ACTIVE', 'NOT_FOR_SALE', 'ARCHIVED');

ALTER TABLE "products"
ADD COLUMN "lifecycleStatus" "ProductLifecycleStatus" NOT NULL DEFAULT 'ACTIVE';

UPDATE "products"
SET "lifecycleStatus" = CASE
  WHEN active = true THEN 'ACTIVE'::"ProductLifecycleStatus"
  ELSE 'NOT_FOR_SALE'::"ProductLifecycleStatus"
END;
