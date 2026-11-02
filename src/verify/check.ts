import { isDeepStrictEqual } from 'node:util'
import type { TxClient } from '../db/transaction.js'
import type { Stock, UpdateKind } from '../domain/stock.js'
import { replayExpected, type RefMessage } from './reference.js'

/**
 * Reconciles `store_stock` and `apply_log` against an independent replay of the queue
 * (see `replayExpected`). Run after the processor exits.
 *
 * Checks: every store's stock / version / last_seq; apply_log has exactly the expected
 * updates, each once, in seq order per store; no extra stores or log rows.
 *
 * @returns Human-readable problems; an empty array means the database is correct.
 */
export async function reconcile(db: TxClient): Promise<string[]> {
  const { rows: msgs } = await db.query<{
    message_id: string
    chain_id: string
    store_id: string
    seq: number
    kind: UpdateKind
    payload: unknown
    receipt_ok: boolean
  }>(`SELECT q.message_id, q.chain_id, q.store_id, q.seq, q.kind, q.payload, r.ready_at IS NOT NULL AS receipt_ok
      FROM queue_messages q JOIN receipt_files r ON r.id = q.receipt_id`)
  const expected = replayExpected(
    msgs.map(
      (m): RefMessage => ({
        messageId: m.message_id,
        chainId: m.chain_id,
        storeId: m.store_id,
        seq: m.seq,
        kind: m.kind,
        payload: m.payload,
        receiptOk: m.receipt_ok,
      }),
    ),
  )

  const { rows: stocks } = await db.query<{
    chain_id: string
    store_id: string
    stock: Stock
    version: number
    last_seq: number
  }>(`SELECT chain_id, store_id, stock, version, last_seq FROM store_stock`)
  const { rows: logs } = await db.query<{
    message_id: string
    chain_id: string
    store_id: string
    seq: number
    kind: string
  }>(`SELECT message_id, chain_id, store_id, seq, kind FROM apply_log ORDER BY apply_pos`)

  const problems: string[] = []
  const k = (c: string, s: string) => `${c}/${s}`
  const stockByStore = new Map(stocks.map((r) => [k(r.chain_id, r.store_id), r]))
  const logByStore = new Map<string, typeof logs>()
  for (const l of logs) {
    const key = k(l.chain_id, l.store_id)
    logByStore.set(key, [...(logByStore.get(key) ?? []), l])
  }

  for (const exp of expected) {
    const key = k(exp.chainId, exp.storeId)
    const row = stockByStore.get(key)
    stockByStore.delete(key)
    if (exp.applied.length === 0) {
      if (row) problems.push(`${key}: has a store_stock row but nothing should be applied`)
    } else if (!row) {
      problems.push(`${key}: missing store_stock row`)
    } else {
      if (!isDeepStrictEqual(row.stock, exp.stock))
        problems.push(`${key}: stock ${JSON.stringify(row.stock)} != expected ${JSON.stringify(exp.stock)}`)
      if (row.version !== exp.version) problems.push(`${key}: version ${row.version} != expected ${exp.version}`)
      if (row.last_seq !== exp.lastSeq) problems.push(`${key}: last_seq ${row.last_seq} != expected ${exp.lastSeq}`)
    }

    const got = (logByStore.get(key) ?? []).map((l) => `${l.seq}:${l.message_id}:${l.kind}`)
    logByStore.delete(key)
    const want = exp.applied.map((a) => `${a.seq}:${a.messageId}:${a.kind}`)
    if (!isDeepStrictEqual(got, want))
      problems.push(`${key}: apply_log has ${got.length} rows (expected ${want.length}) or wrong order/content`)
  }
  for (const key of stockByStore.keys()) problems.push(`${key}: unexpected store_stock row`)
  for (const key of logByStore.keys()) problems.push(`${key}: unexpected apply_log rows`)
  return problems
}
