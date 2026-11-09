-- ASN reservations: when the reservation was claimed for a remote create.
--
-- ADDITIVE ONLY: one nullable column, no default, on a table the previous build reads and writes by named columns. Safe while the
-- previous build serves: it never reads or writes the column. NULL for every existing row, which reads as "no remote create attempt
-- recorded": the guard that uses it (manual purchase-order receipts beside an ASN) then behaves as it did for rows older than this.
ALTER TABLE "wms_asn_maps" ADD COLUMN "remoteCreateAttemptedAt" TIMESTAMP(3);
