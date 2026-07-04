-- Field-hash change detection for HS classification (6igm.5) + defaults so a placeholder row can
-- be created to claim classification before the API call (6igm.8). All safe (nullable add / defaults).
ALTER TABLE "hs_code_proposals" ADD COLUMN "classificationFieldsHash" TEXT;
ALTER TABLE "hs_code_proposals" ALTER COLUMN "source" SET DEFAULT 'pending';
ALTER TABLE "hs_code_proposals" ALTER COLUMN "band" SET DEFAULT 'low';
