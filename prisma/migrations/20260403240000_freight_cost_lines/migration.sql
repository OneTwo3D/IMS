CREATE TABLE "freight_cost_lines" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountForeign" DECIMAL(18,4) NOT NULL,
    "amountGbp" DECIMAL(18,4) NOT NULL,
    "vatable" BOOLEAN NOT NULL DEFAULT false,
    "distributionMethod" "LandedCostMethod" NOT NULL DEFAULT 'BY_VALUE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "freight_cost_lines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "freight_cost_lines" ADD CONSTRAINT "freight_cost_lines_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
