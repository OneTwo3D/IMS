-- Generation token for the "recorded line ids are untrustworthy" mark. ADDITIVE ONLY: one nullable column, no default, no backfill.
--
-- Each amendment of a warehouse order's lines sets a fresh token with the mark; only the holder of the CURRENT token may store the
-- replacement snapshot and clear the mark (compare-and-set), so two overlapping amendments cannot make each other's stale ids trusted.
ALTER TABLE "wms_order_push_links" ADD COLUMN "line_snapshot_token" TEXT;
