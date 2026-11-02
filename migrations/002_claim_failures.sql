-- Failure tracking per store, so one misbehaving store (e.g. an unexpected error while
-- applying its messages) is retried with backoff and then set aside instead of being
-- retried forever and keeping the run from finishing.
ALTER TABLE store_claims
  ADD COLUMN IF NOT EXISTS failures   INTEGER NOT NULL DEFAULT 0,  -- consecutive failed attempts
  ADD COLUMN IF NOT EXISTS last_error TEXT;                        -- message of the latest failure
