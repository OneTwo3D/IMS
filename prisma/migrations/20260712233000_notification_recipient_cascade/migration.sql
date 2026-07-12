-- Targeted notifications must die with their recipient (Codex r7): ON DELETE
-- SET NULL converted them into broadcasts (userId IS NULL = visible to EVERY
-- user), leaking admin-only operational detail (warehouse codes, ASN ids,
-- SKUs, failure detail) to READONLY/WAREHOUSE/SUPPLIER users when an admin
-- account was deleted.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_userId_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
