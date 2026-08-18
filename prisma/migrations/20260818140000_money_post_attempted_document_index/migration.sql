-- o3d-0m56 round 6, Codex CRITICAL #2: keep the money-post fence's rival-attempt lookup cheap now
-- that it is keyed on the DOCUMENT as well as the local scope.
--
-- The fence asks, immediately before every money post and while holding that document's advisory
-- lock: "which other rows for this connector and type have ever been sent, either in my scope or
-- against my `accountingInvoiceId`?" The scope arm is served by
-- `accounting_sync_logs_connector_referenceType_referenceId_idx`. The document arm is a JSON
-- predicate on `payload` and is served by nothing, so an OR of the two can degrade to a scan of
-- the whole table — inside a lock, on the path that moves money.
--
-- PARTIAL, and that is what makes it small. `remoteAttemptedAt` is written by exactly one place:
-- the fence, immediately before a remote money call. So the indexed set is "money rows that have
-- actually been sent" — one entry per payment this business has ever made — rather than every
-- accounting sync row ever written. Postgres can satisfy the connector/type/attempted conjunction
-- from it and apply the OR as a filter over that handful of rows.
--
-- Deliberately NOT an expression index on `payload->'accountingInvoiceId'`: Prisma's JSON filter
-- generates a `#>` path comparison whose exact form is an implementation detail of the client, and
-- an expression index that stops matching it is dead weight nobody notices. Narrowing the row set
-- is robust to that.
CREATE INDEX IF NOT EXISTS "accounting_sync_logs_money_attempted_idx"
ON "accounting_sync_logs" ("connector", "type")
WHERE "remoteAttemptedAt" IS NOT NULL;
