ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "accountingContactId" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "accountingContactId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_accountingContactId_key" ON "suppliers"("accountingContactId");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_accountingContactId_key" ON "customers"("accountingContactId");
