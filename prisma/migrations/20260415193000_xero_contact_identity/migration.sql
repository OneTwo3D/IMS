ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "xeroContactId" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "xeroContactId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_xeroContactId_key" ON "suppliers"("xeroContactId");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_xeroContactId_key" ON "customers"("xeroContactId");
