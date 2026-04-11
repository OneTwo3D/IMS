-- Add manual delivery days override to suppliers
ALTER TABLE "suppliers" ADD COLUMN "manualDeliveryDays" INTEGER;
