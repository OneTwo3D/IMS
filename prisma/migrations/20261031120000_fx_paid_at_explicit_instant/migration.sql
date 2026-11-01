-- Provenance of a payment instant for the FX gain/loss report. A date-only input (a date picker) is stored as that day's midnight UTC, so a stored paidAt of exactly 00:00:00.000Z was ambiguous: it
-- could equally be an explicit instant at midnight. The report read every such value as date-only (end of day) while the receipt's journal used the explicit instant's rate.
--
-- ADDITIVE ONLY: one nullable column on each table. NULL (every existing row, every date-only input, every writer that does not know the column) means "unknown or date-only", which keeps today's reading,
-- so nothing changes for any reader that does not know the column. A value is honoured by the report only while it still equals paidAt.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "paid_at_explicit_instant" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "purchase_invoices" ADD COLUMN "paid_at_explicit_instant" TIMESTAMP(3);
