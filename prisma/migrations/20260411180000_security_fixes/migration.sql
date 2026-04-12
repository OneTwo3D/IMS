-- Security fix suite: per-user notification read receipts, DB-backed one-time
-- tokens (replaces in-memory token store), and staged TOTP secret for 2FA setup.

-- pendingTotpSecret staging column on users
ALTER TABLE "users" ADD COLUMN "pendingTotpSecret" TEXT;

-- one_time_tokens
CREATE TABLE "one_time_tokens" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_tokens_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "one_time_tokens_expiresAt_idx" ON "one_time_tokens"("expiresAt");

-- notifications (must exist before read_receipts FK)
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionUrl" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notifications_userId_read_createdAt_idx" ON "notifications"("userId", "read", "createdAt");

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- notification_read_receipts
CREATE TABLE "notification_read_receipts" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_read_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_read_receipts_notificationId_userId_key" ON "notification_read_receipts"("notificationId", "userId");
CREATE INDEX "notification_read_receipts_userId_idx" ON "notification_read_receipts"("userId");

ALTER TABLE "notification_read_receipts" ADD CONSTRAINT "notification_read_receipts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_read_receipts" ADD CONSTRAINT "notification_read_receipts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
