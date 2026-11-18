-- Additive: the pattern and counter of each kind of document IMS numbers itself, and an optional reference on a shipment. No existing column is changed and no row is written: a kind with no row uses its built-in default pattern, which reproduces the numbers minted before patterns existed, and a shipment keeps a NULL reference until an operator sets a shipment pattern.
CREATE TABLE "document_number_sequences" (
    "document_type" TEXT NOT NULL,
    "pattern" TEXT,
    "scope_key" TEXT,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "document_number_sequences_pkey" PRIMARY KEY ("document_type")
);

ALTER TABLE "shipments" ADD COLUMN "reference" TEXT;

CREATE UNIQUE INDEX "shipments_reference_key" ON "shipments"("reference");
