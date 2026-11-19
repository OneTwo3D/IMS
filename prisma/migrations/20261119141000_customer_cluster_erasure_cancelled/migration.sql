-- CRM cluster erasure: an operator can CANCEL a PENDING request (releases the merge/unmerge block; records already erased stay erased). ADDITIVE ONLY: one new enum
-- value, in its own file (a value added here cannot be used until this transaction has committed; the column migration that follows uses it).
ALTER TYPE "CustomerClusterErasureStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
