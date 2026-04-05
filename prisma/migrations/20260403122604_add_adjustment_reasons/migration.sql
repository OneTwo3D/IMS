-- CreateTable
CREATE TABLE "adjustment_reasons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "xeroAccountCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adjustment_reasons_pkey" PRIMARY KEY ("id")
);
