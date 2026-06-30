-- Phase 8 (q66in.1.1): dispatch ingestion runs as a WmsSyncJob, like the other
-- Mintsoft sync jobs, so it appears in the connector health/observability views.
ALTER TYPE "WmsSyncJobType" ADD VALUE IF NOT EXISTS 'DISPATCH_SYNC';
