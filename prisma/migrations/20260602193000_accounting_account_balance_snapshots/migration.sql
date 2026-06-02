CREATE TABLE "accounting_account_balance_snapshots" (
  "id" TEXT NOT NULL,
  "connector" TEXT NOT NULL DEFAULT 'xero',
  "externalAccountId" TEXT NOT NULL,
  "accountCode" TEXT,
  "accountName" TEXT NOT NULL,
  "balanceDate" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "amountForeign" DECIMAL(18, 6) NOT NULL,
  "amountBase" DECIMAL(18, 6) NOT NULL,
  "sourcePayloadRef" TEXT,
  "syncRunId" TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "accounting_account_balance_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_account_balance_snapshots_connector_externalAcco_key"
  ON "accounting_account_balance_snapshots"("connector", "externalAccountId", "balanceDate", "currency");

CREATE INDEX "accounting_account_balance_snapshots_connector_accountCode__idx"
  ON "accounting_account_balance_snapshots"("connector", "accountCode", "balanceDate");

CREATE INDEX "accounting_account_balance_snapshots_connector_balanceDate_idx"
  ON "accounting_account_balance_snapshots"("connector", "balanceDate");
