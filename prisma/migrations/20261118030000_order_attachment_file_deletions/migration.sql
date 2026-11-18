-- Additive: a queue of attachment files owed a deletion, written in the same transaction as the attachment-row deletion (erasure, draft-order delete) and drained by a retryable sweep.
-- Nothing existing is touched.
CREATE TABLE "order_attachment_file_deletions" (
    "stored_name" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_attachment_file_deletions_pkey" PRIMARY KEY ("stored_name")
);
