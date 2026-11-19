-- Merge holds: a hold request whose answer was lost leaves the order in a "may be held" state. ADDITIVE ONLY: one new enum value, no row touched, no backfill.
ALTER TYPE "WmsMergeHoldState" ADD VALUE 'UNKNOWN';
