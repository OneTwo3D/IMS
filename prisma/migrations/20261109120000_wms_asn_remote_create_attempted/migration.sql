-- ASN reservations: when the reservation was claimed for a remote create.
--
-- One nullable column, no default, on a table the previous build reads and writes by named columns. Safe while the previous build
-- serves: it never reads or writes the column.
ALTER TABLE "wms_asn_maps" ADD COLUMN "remoteCreateAttemptedAt" TIMESTAMP(3);

-- EXISTING UNCLOSED CREATE_PENDING ROWS ARE STAMPED, CONSERVATIVELY. The previous build claimed a reservation (CREATE_IN_FLIGHT) and, when
-- the claim went stale, demoted it back to CREATE_PENDING without leaving any record that the warehouse might already hold the ASN. A
-- NULL on such a row would therefore read as "never sent" and let a manual purchase-order receipt through beside an ASN that may be
-- live. Stamping them makes them block until the creator reconciles them (the next create request revalidates, looks for a matching
-- remote ASN, and either adopts it, discards the reservation, or claims and creates), after which they close or become OPEN.
-- Rows that are closed, and rows in any other status, are untouched.
UPDATE "wms_asn_maps" SET "remoteCreateAttemptedAt" = now() WHERE "status" = 'CREATE_PENDING' AND "closedAt" IS NULL;
