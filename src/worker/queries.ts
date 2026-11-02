// All SQL used by the workers (Repository-style module: one function per statement).
// Functions taking a `TxClient` are meant to run inside the per-message transaction.
import type { HeadMessage, ReceiptState } from '../domain/decide.js'
import type { Stock, UpdateKind } from '../domain/stock.js'
import type { TxClient } from '../db/transaction.js'

/** Identifies one store. */
export interface StoreKey {
  readonly chainId: string
  readonly storeId: string
}

/** Tuning shared by the claim queries. */
export interface ClaimSettings {
  /** How long a claim stays valid without renewal. */
  readonly leaseMs: number
  /** A store with this many failures is set aside (not claimed, not counted as remaining work). */
  readonly maxFailures: number
}

/**
 * Per-store state of the head message, mirroring `decideNext` (src/domain/decide.ts):
 * - actionable: discard / apply / skip-to-snapshot can run now
 * - waiting:    receipt upload not finished yet (will become actionable)
 * - blocked:    cannot progress in this run (failed receipt w/o later snapshot, or missing seq)
 * Uses the DB clock (now()) so all workers agree on receipt readiness and lease expiry.
 */
const storeStatesSql = `
  WITH heads AS (
    SELECT DISTINCT ON (chain_id, store_id) id, chain_id, store_id, seq, kind, receipt_id
    FROM queue_messages
    WHERE processed_at IS NULL
    ORDER BY chain_id, store_id, seq, id
  )
  SELECT h.chain_id, h.store_id, h.id AS head_id, c.locked_until, COALESCE(c.failures, 0) AS failures,
    CASE
      WHEN h.seq <= COALESCE(s.last_seq, 0) THEN 'actionable'
      WHEN h.kind = 'delta' AND h.seq <> COALESCE(s.last_seq, 0) + 1 THEN 'blocked'
      WHEN r.ready_at <= now() THEN 'actionable'
      WHEN r.ready_at IS NOT NULL THEN 'waiting'
      WHEN EXISTS (
        SELECT 1 FROM queue_messages n
        WHERE n.chain_id = h.chain_id AND n.store_id = h.store_id
          AND n.processed_at IS NULL AND n.kind = 'snapshot' AND n.seq > h.seq
      ) THEN 'actionable'
      ELSE 'blocked'
    END AS state
  FROM heads h
  JOIN receipt_files r ON r.id = h.receipt_id
  LEFT JOIN store_stock s ON s.chain_id = h.chain_id AND s.store_id = h.store_id
  LEFT JOIN store_claims c ON c.chain_id = h.chain_id AND c.store_id = h.store_id`

/**
 * Stores that have work to do right now and are not claimed by a live worker, oldest
 * pending message first (fairness: the store waiting longest goes first).
 */
export async function findClaimableStores(db: TxClient, limit: number, cfg: ClaimSettings): Promise<StoreKey[]> {
  const { rows } = await db.query<{ chain_id: string; store_id: string }>(
    `SELECT chain_id, store_id FROM (${storeStatesSql}) st
     WHERE state = 'actionable' AND failures < $2
       AND (locked_until IS NULL OR locked_until < now())
     ORDER BY head_id
     LIMIT $1`,
    [limit, cfg.maxFailures],
  )
  return rows.map((r) => ({ chainId: r.chain_id, storeId: r.store_id }))
}

/**
 * True while any store still has work that can be done now or later (actionable or waiting),
 * including stores currently claimed by other workers. False means the run is complete:
 * everything left is blocked or set aside.
 */
export async function hasRemainingWork(db: TxClient, cfg: ClaimSettings): Promise<boolean> {
  const { rows } = await db.query<{ remaining: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM (${storeStatesSql}) st
       WHERE state IN ('actionable', 'waiting') AND failures < $1
     ) AS remaining`,
    [cfg.maxFailures],
  )
  return rows[0]!.remaining
}

/**
 * Atomically claims a store for `workerId` if it is free (never claimed, released, or its
 * lease expired) and not set aside. Concurrent callers cannot both succeed: the upsert
 * locks the claim row and re-checks the condition.
 *
 * @returns true if this worker now holds the claim.
 */
export async function tryClaim(db: TxClient, key: StoreKey, workerId: string, cfg: ClaimSettings): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO store_claims (chain_id, store_id, locked_by, locked_until)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (chain_id, store_id) DO UPDATE
       SET locked_by = EXCLUDED.locked_by, locked_until = EXCLUDED.locked_until
       WHERE (store_claims.locked_until IS NULL OR store_claims.locked_until < now())
         AND store_claims.failures < $5`,
    [key.chainId, key.storeId, workerId, cfg.leaseMs / 1000, cfg.maxFailures],
  )
  return rowCount === 1
}

/**
 * Renews this worker's claim and row-locks it until the transaction ends. This is the
 * fence that makes a stale worker harmless: if another worker has taken the store over,
 * `locked_by` no longer matches and this returns false, so the caller must abort.
 * The row lock also serialises any concurrent `tryClaim` on the same store.
 */
export async function renewClaim(db: TxClient, key: StoreKey, workerId: string, cfg: ClaimSettings): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE store_claims SET locked_until = now() + make_interval(secs => $4)
     WHERE chain_id = $1 AND store_id = $2 AND locked_by = $3`,
    [key.chainId, key.storeId, workerId, cfg.leaseMs / 1000],
  )
  return rowCount === 1
}

/** Releases this worker's claim (no-op if it was taken over) and clears the failure count. */
export async function releaseClaim(db: TxClient, key: StoreKey, workerId: string): Promise<void> {
  await db.query(
    `UPDATE store_claims SET locked_by = NULL, locked_until = NULL, failures = 0, last_error = NULL
     WHERE chain_id = $1 AND store_id = $2 AND locked_by = $3`,
    [key.chainId, key.storeId, workerId],
  )
}

/**
 * Records a failed attempt and releases the claim, but keeps the store unclaimable for
 * `backoffMs` (by leaving an unowned lease) so it is not retried in a hot loop.
 */
export async function recordFailure(
  db: TxClient,
  key: StoreKey,
  workerId: string,
  error: string,
  backoffMs: number,
): Promise<void> {
  await db.query(
    `UPDATE store_claims
     SET locked_by = NULL, locked_until = now() + make_interval(secs => $5),
         failures = failures + 1, last_error = $4
     WHERE chain_id = $1 AND store_id = $2 AND locked_by = $3`,
    [key.chainId, key.storeId, workerId, error, backoffMs / 1000],
  )
}

/** Gives every set-aside store a fresh set of attempts (called once at app start). */
export async function resetFailures(db: TxClient): Promise<void> {
  await db.query(`UPDATE store_claims SET failures = 0, last_error = NULL WHERE failures > 0`)
}

/** Current applied state of a store (defaults for a store with no row yet). */
export interface StoreState {
  readonly stock: Stock
  readonly lastSeq: number
}

/** Reads the store's current stock and last applied seq. */
export async function loadStoreState(db: TxClient, key: StoreKey): Promise<StoreState> {
  const { rows } = await db.query<{ stock: Stock; last_seq: number }>(
    `SELECT stock, last_seq FROM store_stock WHERE chain_id = $1 AND store_id = $2`,
    [key.chainId, key.storeId],
  )
  const row = rows[0]
  return row ? { stock: row.stock, lastSeq: row.last_seq } : { stock: {}, lastSeq: 0 }
}

/** A head message with everything needed to decide and apply it. */
export interface LoadedHead extends HeadMessage {
  readonly id: string
  readonly messageId: string
  readonly payload: unknown
}

/** Loads the store's lowest-seq unprocessed message, or null if it has none. */
export async function loadHead(db: TxClient, key: StoreKey): Promise<LoadedHead | null> {
  const { rows } = await db.query<{
    id: string
    message_id: string
    seq: number
    kind: UpdateKind
    payload: unknown
    receipt: ReceiptState
  }>(
    `SELECT q.id, q.message_id, q.seq, q.kind, q.payload,
       CASE WHEN r.ready_at IS NULL THEN 'failed'
            WHEN r.ready_at <= now() THEN 'ready'
            ELSE 'pending' END AS receipt
     FROM queue_messages q JOIN receipt_files r ON r.id = q.receipt_id
     WHERE q.chain_id = $1 AND q.store_id = $2 AND q.processed_at IS NULL
     ORDER BY q.seq, q.id
     LIMIT 1`,
    [key.chainId, key.storeId],
  )
  const r = rows[0]
  return r
    ? { id: r.id, messageId: r.message_id, seq: r.seq, kind: r.kind, payload: r.payload, receipt: r.receipt }
    : null
}

/** Seq of the store's next unprocessed snapshot after `afterSeq`, or null. */
export async function findNextSnapshotSeq(db: TxClient, key: StoreKey, afterSeq: number): Promise<number | null> {
  const { rows } = await db.query<{ seq: number | null }>(
    `SELECT min(seq) AS seq FROM queue_messages
     WHERE chain_id = $1 AND store_id = $2 AND processed_at IS NULL AND kind = 'snapshot' AND seq > $3`,
    [key.chainId, key.storeId, afterSeq],
  )
  return rows[0]?.seq ?? null
}

/**
 * Applies one update: writes the new stock, logs it, and marks the message processed —
 * the applied row as `applied`, its retransmitted copies (same message_id) as `duplicate`.
 * Must run in the per-message transaction so the three writes commit or fail together.
 */
export async function applyMessage(
  db: TxClient,
  key: StoreKey,
  head: LoadedHead,
  newStock: Stock,
  workerId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO store_stock (chain_id, store_id, stock, version, last_seq, updated_at)
     VALUES ($1, $2, $3::jsonb, 1, $4, now())
     ON CONFLICT (chain_id, store_id) DO UPDATE
       SET stock = EXCLUDED.stock, version = store_stock.version + 1,
           last_seq = EXCLUDED.last_seq, updated_at = now()`,
    [key.chainId, key.storeId, JSON.stringify(newStock), head.seq],
  )
  await db.query(
    `INSERT INTO apply_log (message_id, chain_id, store_id, seq, kind, worker_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [head.messageId, key.chainId, key.storeId, head.seq, head.kind, workerId],
  )
  await db.query(
    `UPDATE queue_messages
     SET processed_at = now(), outcome = CASE WHEN id = $4 THEN 'applied' ELSE 'duplicate' END
     WHERE chain_id = $1 AND store_id = $2 AND message_id = $3 AND processed_at IS NULL`,
    [key.chainId, key.storeId, head.messageId, head.id],
  )
}

/**
 * Marks a head whose seq is already covered as processed without applying it:
 * `duplicate` if its update is in apply_log, else `superseded`.
 */
export async function discardMessage(db: TxClient, head: LoadedHead): Promise<void> {
  await db.query(
    `UPDATE queue_messages
     SET processed_at = now(),
         outcome = CASE WHEN EXISTS (SELECT 1 FROM apply_log WHERE message_id = $2)
                        THEN 'duplicate' ELSE 'superseded' END
     WHERE id = $1`,
    [head.id, head.messageId],
  )
}

/** Marks every unprocessed message of the store with `fromSeq <= seq < toSeq` as superseded. */
export async function supersedeRange(db: TxClient, key: StoreKey, fromSeq: number, toSeq: number): Promise<void> {
  await db.query(
    `UPDATE queue_messages SET processed_at = now(), outcome = 'superseded'
     WHERE chain_id = $1 AND store_id = $2 AND processed_at IS NULL AND seq >= $3 AND seq < $4`,
    [key.chainId, key.storeId, fromSeq, toSeq],
  )
}
