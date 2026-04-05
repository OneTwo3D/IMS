-- Rename COMPLETED → RECEIVED in StockTransferStatus enum
ALTER TYPE "StockTransferStatus" RENAME VALUE 'COMPLETED' TO 'RECEIVED';

-- Add productName to StockTransferLine
ALTER TABLE "stock_transfer_lines" ADD COLUMN "productName" TEXT NOT NULL DEFAULT '';
