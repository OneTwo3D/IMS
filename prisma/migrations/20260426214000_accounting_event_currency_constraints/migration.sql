-- Persist accounting event currency and enforce external accounting ids.

ALTER TABLE "accounting_events"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'GBP';

ALTER TABLE "accounting_events"
  ALTER COLUMN "currency" DROP DEFAULT;

DROP INDEX "accounting_events_externalSystem_externalId_idx";

CREATE UNIQUE INDEX "accounting_events_externalSystem_externalId_key"
  ON "accounting_events"("externalSystem", "externalId");
