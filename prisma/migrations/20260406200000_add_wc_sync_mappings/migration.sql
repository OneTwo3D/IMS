CREATE TABLE "wc_tax_mappings" (
    "id" TEXT NOT NULL,
    "wcTaxClass" TEXT NOT NULL,
    "taxRateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wc_tax_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wc_status_mappings" (
    "id" TEXT NOT NULL,
    "wcStatus" TEXT NOT NULL,
    "imsStatus" "SalesOrderStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wc_status_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wc_tax_mappings_wcTaxClass_key" ON "wc_tax_mappings"("wcTaxClass");
CREATE UNIQUE INDEX "wc_status_mappings_wcStatus_key" ON "wc_status_mappings"("wcStatus");

ALTER TABLE "wc_tax_mappings" ADD CONSTRAINT "wc_tax_mappings_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed default status mappings
INSERT INTO "wc_status_mappings" ("id", "wcStatus", "imsStatus", "updatedAt") VALUES
  ('wcsm_pending', 'pending', 'PENDING_PAYMENT', NOW()),
  ('wcsm_failed', 'failed', 'PENDING_PAYMENT', NOW()),
  ('wcsm_on_hold', 'on-hold', 'ON_HOLD', NOW()),
  ('wcsm_processing', 'processing', 'PROCESSING', NOW()),
  ('wcsm_completed', 'completed', 'COMPLETED', NOW()),
  ('wcsm_cancelled', 'cancelled', 'CANCELLED', NOW()),
  ('wcsm_refunded', 'refunded', 'REFUNDED', NOW());
