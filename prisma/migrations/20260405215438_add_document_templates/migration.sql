-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "headerNote" TEXT,
    "footerNote" TEXT,
    "termsText" TEXT,
    "showLogo" BOOLEAN NOT NULL DEFAULT true,
    "showVat" BOOLEAN NOT NULL DEFAULT true,
    "showPaymentTerms" BOOLEAN NOT NULL DEFAULT false,
    "paymentTermsText" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_type_key" ON "document_templates"("type");
