CREATE TABLE "cron_runs" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "status" TEXT NOT NULL,
  "countsJson" JSONB,
  "errorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cron_runs_runId_key" ON "cron_runs"("runId");
CREATE INDEX "cron_runs_jobName_startedAt_idx" ON "cron_runs"("jobName", "startedAt");
CREATE INDEX "cron_runs_status_startedAt_idx" ON "cron_runs"("status", "startedAt");
