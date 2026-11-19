-- A customer's timeline reads their orders newest first. CONCURRENTLY, in its own file: sales_orders is a hot table and a plain CREATE INDEX would block
-- writes for the build; CONCURRENTLY cannot run inside a transaction. ADDITIVE ONLY. The name is Prisma's default for the @@index in schema.prisma.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sales_orders_customerId_createdAt_idx"
ON "sales_orders" ("customerId", "createdAt" DESC);
