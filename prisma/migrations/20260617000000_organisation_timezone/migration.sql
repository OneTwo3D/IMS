-- Add a nullable display timezone to the organisation. Plain nullable add-column
-- (no backfill / NOT NULL) per docs/migration-conventions.md. Null falls back to
-- Europe/London in application code.
ALTER TABLE "organisations" ADD COLUMN "timezone" TEXT;
