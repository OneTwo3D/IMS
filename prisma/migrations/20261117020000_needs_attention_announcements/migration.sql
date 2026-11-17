-- Additive: a new table only; no existing row is touched. Which failing source rows the "Needs attention" bell has already announced.
-- Replaces a per-category JSON blob in `settings` (never released) with one row per announced item, so the set is unbounded and an
-- announcement is exactly-once under concurrent passes (the INSERT ... ON CONFLICT DO NOTHING that wins sends the notification).
-- No foreign key on purpose: the source rows live in several tables and a row is deleted when its source is no longer open.
CREATE TABLE "needs_attention_announcements" (
    "category" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "announced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "needs_attention_announcements_pkey" PRIMARY KEY ("category", "source_id")
);
