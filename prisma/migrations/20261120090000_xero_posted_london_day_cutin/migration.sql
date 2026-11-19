-- o3d-oe1b0: the instant the business (London) day replaced the UTC day on the documents and payments IMS posts to Xero.
-- The reconciliation pack's R16 holds a posted receipt or storefront invoice to ONE date convention: the UTC day for a posting
-- created before this instant, the London day for one created on or after it. Stamped once, at deploy, so no manual step is needed;
-- on a fresh install it precedes every posting, so everything is post-cut-in. System-managed (not an operator preference), stored as a
-- UTC ISO text like the other raw non-sensitive settings. ON CONFLICT DO NOTHING keeps the original stamp if the migration is re-run.
-- to_char(...) is datestyle-independent.
INSERT INTO "settings" ("key", "value", "updatedAt")
VALUES ('xero_posted_london_day_cutin_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NOW())
ON CONFLICT ("key") DO NOTHING;
