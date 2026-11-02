-- Processing state added on top of the provided schema.sql (which must not be modified).
-- Every statement is idempotent so the migration can safely be re-applied.

-- Per-row processing marker on the queue. A row is "processed" once it was handled,
-- whatever the outcome; pending rows are exactly those with processed_at IS NULL.
ALTER TABLE queue_messages
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  -- applied    = this row's update was applied to store_stock and logged in apply_log
  -- duplicate  = a retransmitted copy of an update that was applied via another row
  -- superseded = never applicable (failed receipt) or skipped because a later snapshot replaced it
  ADD COLUMN IF NOT EXISTS outcome TEXT
    CHECK (outcome IN ('applied', 'duplicate', 'superseded'));

-- Hot-path index: finds each store's next pending message without scanning processed rows.
CREATE INDEX IF NOT EXISTS queue_messages_pending
  ON queue_messages (chain_id, store_id, seq)
  WHERE processed_at IS NULL;

-- Exactly-once audit trail, enforced by the database: an update can be logged (billed) once.
CREATE UNIQUE INDEX IF NOT EXISTS apply_log_message_id_uq ON apply_log (message_id);
CREATE UNIQUE INDEX IF NOT EXISTS apply_log_store_seq_uq ON apply_log (chain_id, store_id, seq);

-- Per-store lease: guarantees a single worker processes a store at a time.
-- A claim is free when locked_until is NULL or in the past (expired leases are taken over).
CREATE TABLE IF NOT EXISTS store_claims (
  chain_id     UUID NOT NULL,
  store_id     UUID NOT NULL,
  locked_by    TEXT,         -- worker_id of the lease holder
  locked_until TIMESTAMPTZ,  -- lease expiry, compared against the DB clock (now())
  PRIMARY KEY (chain_id, store_id)
);
