-- Split name into firstName + lastName, add taxNumber
ALTER TABLE "customers" ADD COLUMN "firstName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "customers" ADD COLUMN "lastName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "customers" ADD COLUMN "taxNumber" TEXT;

-- Migrate existing data: put full name into firstName
UPDATE "customers" SET "firstName" = "name" WHERE "name" IS NOT NULL;

-- Drop old name column
ALTER TABLE "customers" DROP COLUMN "name";
