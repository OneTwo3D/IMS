-- audit-v08m: follow-up sync type that allocates a posted supplier credit note
-- (ACCPAYCREDIT) to the bill it offsets, so the bill stops showing as
-- outstanding in Xero's AP aging.
-- AlterEnum
ALTER TYPE "AccountingSyncType" ADD VALUE 'PURCHASE_CREDIT_NOTE_ALLOCATION';
