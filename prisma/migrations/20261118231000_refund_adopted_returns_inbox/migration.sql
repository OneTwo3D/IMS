-- A refund that adopts an already-restocked returns-inbox arrival links to it (o3d-iil0b). Additive; existing refunds adopt nothing.
ALTER TABLE "sales_order_refunds" ADD COLUMN "adopted_returns_inbox_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
