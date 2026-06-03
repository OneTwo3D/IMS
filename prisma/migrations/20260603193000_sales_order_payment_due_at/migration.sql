-- Optional receivable due date for AR aging parity with purchase invoice dueDate.
ALTER TABLE "sales_orders"
  ADD COLUMN "paymentDueAt" TIMESTAMP(3);
