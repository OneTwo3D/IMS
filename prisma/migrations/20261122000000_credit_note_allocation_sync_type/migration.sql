-- Sales credit-note settlement (behind the xero_credit_note_allocation_enabled system setting, default off):
-- CREDIT_NOTE_ALLOCATION allocates a posted sales credit note to its posted invoice, or posts the refund cash-out against it.
--
-- ALTER TYPE ... ADD VALUE must run in its own migration because Postgres forbids it in the same
-- transaction as any later DDL that uses the value. Additive only; nothing uses the value until the setting is turned on.
ALTER TYPE "AccountingSyncType" ADD VALUE 'CREDIT_NOTE_ALLOCATION';
