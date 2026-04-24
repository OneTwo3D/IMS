-- Prevent duplicate retry-created accounting journals where the application
-- supplies a deterministic business idempotency key in the payload.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_logs_idempotency_key_uq
  ON accounting_sync_logs (
    connector,
    type,
    "referenceType",
    "referenceId",
    ((payload ->> '_idempotencyKey'))
  )
  WHERE payload ? '_idempotencyKey'
    AND status IN ('PENDING', 'PROCESSING', 'SYNCED');
