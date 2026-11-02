import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { StoreKey } from '../../src/worker/queries.js'

/** Receipt state for a test message: ready (in the past), pending (future), failed (NULL). */
export type TestReceipt = 'ready' | 'pending' | 'failed'

export interface TestMessage {
  seq: number
  kind: 'snapshot' | 'delta'
  payload: unknown
  receipt?: TestReceipt
  /** Reuse a message_id to create a retransmitted duplicate. */
  messageId?: string
}

/** Creates a new random store key. */
export const newStore = (): StoreKey => ({ chainId: randomUUID(), storeId: randomUUID() })

/**
 * Inserts messages (in the given array order = arrival order) with their receipts.
 * @returns The message_ids in the same order.
 */
export async function insertMessages(pool: pg.Pool, store: StoreKey, msgs: TestMessage[]): Promise<string[]> {
  const ids: string[] = []
  for (const m of msgs) {
    const receiptId = randomUUID()
    const readyAt = { ready: "now() - interval '1 hour'", pending: "now() + interval '1 hour'", failed: 'NULL' }[
      m.receipt ?? 'ready'
    ]
    await pool.query(`INSERT INTO receipt_files (id, ready_at) VALUES ($1, ${readyAt})`, [receiptId])
    const messageId = m.messageId ?? randomUUID()
    await pool.query(
      `INSERT INTO queue_messages (message_id, chain_id, store_id, seq, kind, payload, receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, store.chainId, store.storeId, m.seq, m.kind, JSON.stringify(m.payload), receiptId],
    )
    ids.push(messageId)
  }
  return ids
}

/** Reads a store's stock row (or undefined). */
export async function getStock(pool: pg.Pool, s: StoreKey) {
  const { rows } = await pool.query(`SELECT stock, version, last_seq FROM store_stock WHERE chain_id=$1 AND store_id=$2`, [
    s.chainId,
    s.storeId,
  ])
  return rows[0] as { stock: Record<string, unknown>; version: number; last_seq: number } | undefined
}

/** Reads a store's queue rows as "seq:outcome" in seq order. */
export async function outcomes(pool: pg.Pool, s: StoreKey): Promise<string[]> {
  const { rows } = await pool.query<{ seq: number; outcome: string | null }>(
    `SELECT seq, outcome FROM queue_messages WHERE chain_id=$1 AND store_id=$2 ORDER BY seq, id`,
    [s.chainId, s.storeId],
  )
  return rows.map((r) => `${r.seq}:${r.outcome ?? 'pending'}`)
}

/** Reads the seqs logged for a store, in apply order. */
export async function loggedSeqs(pool: pg.Pool, s: StoreKey): Promise<number[]> {
  const { rows } = await pool.query<{ seq: number }>(
    `SELECT seq FROM apply_log WHERE chain_id=$1 AND store_id=$2 ORDER BY apply_pos`,
    [s.chainId, s.storeId],
  )
  return rows.map((r) => r.seq)
}
