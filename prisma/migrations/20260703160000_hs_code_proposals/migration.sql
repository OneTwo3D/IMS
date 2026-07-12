-- HS-code classification proposals awaiting human review (6igm.3). New table + enum; safe.
CREATE TYPE "HsCodeProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "hs_code_proposals" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "proposedHsCode" TEXT,
    "proposedCustomsDescription" TEXT,
    "source" TEXT NOT NULL,
    "modelConfidence" INTEGER NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "band" TEXT NOT NULL,
    "flags" TEXT NOT NULL DEFAULT '',
    "writeBlocking" BOOLEAN NOT NULL DEFAULT false,
    "declarable" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT NOT NULL DEFAULT '',
    "status" "HsCodeProposalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hs_code_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hs_code_proposals_status_createdAt_idx" ON "hs_code_proposals"("status", "createdAt");
CREATE INDEX "hs_code_proposals_productId_idx" ON "hs_code_proposals"("productId");

-- At most one PENDING proposal per product (partial unique index; DB-enforced dedup). Prisma's
-- schema language can't express a filtered unique, so it lives only here; proposeHsCodeForProduct
-- catches the resulting P2002 and updates the existing PENDING row instead of inserting a second.
CREATE UNIQUE INDEX "hs_code_proposals_one_pending_per_product" ON "hs_code_proposals"("productId") WHERE "status" = 'PENDING';

ALTER TABLE "hs_code_proposals" ADD CONSTRAINT "hs_code_proposals_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
