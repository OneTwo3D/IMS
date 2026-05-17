ALTER TABLE "cron_runs"
  ADD CONSTRAINT "cron_runs_status_check"
  CHECK ("status" IN ('completed', 'failed', 'skipped')) NOT VALID;

ALTER TABLE "cron_runs" VALIDATE CONSTRAINT "cron_runs_status_check";
