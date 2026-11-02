import { applyUpdate, type Stock, type UpdateKind } from '../domain/stock.js'

/** One queue row as the reference model sees it. */
export interface RefMessage {
  readonly messageId: string
  readonly chainId: string
  readonly storeId: string
  readonly seq: number
  readonly kind: UpdateKind
  readonly payload: unknown
  /** False when the receipt upload failed for good (ready_at IS NULL). */
  readonly receiptOk: boolean
}

/** Expected final state of one store after the backlog is fully drained. */
export interface RefStore {
  readonly chainId: string
  readonly storeId: string
  readonly stock: Stock
  readonly version: number
  readonly lastSeq: number
  /** message_ids that must appear in apply_log, in apply order. */
  readonly applied: Array<{ messageId: string; seq: number; kind: UpdateKind }>
}

/**
 * Independent, deliberately naive replay of the whole update stream (the "answer key").
 * It does not share code with the workers' coordination logic, only `applyUpdate`
 * (which has its own unit tests).
 *
 * Per store: drop retransmits (keep one message per seq), then walk seqs upward from 1:
 * apply when the receipt is OK; on a failed receipt, jump to the next snapshot if any,
 * otherwise stop; a missing delta seq also stops (a snapshot may follow a gap).
 * Assumes every non-failed receipt is ready, i.e. it describes the final state.
 */
export function replayExpected(messages: readonly RefMessage[]): RefStore[] {
  const byStore = new Map<string, Map<number, RefMessage>>()
  for (const m of messages) {
    const key = `${m.chainId}/${m.storeId}`
    const seqs = byStore.get(key) ?? new Map<number, RefMessage>()
    if (!seqs.has(m.seq)) seqs.set(m.seq, m)
    byStore.set(key, seqs)
  }

  const result: RefStore[] = []
  for (const seqs of byStore.values()) {
    const ordered = [...seqs.values()].sort((a, b) => a.seq - b.seq)
    const first = ordered[0]!
    let stock: Stock = {}
    let lastSeq = 0
    const applied: RefStore['applied'] = []

    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i]!
      if (m.kind === 'delta' && m.seq !== lastSeq + 1) break // gap before a delta
      if (!m.receiptOk) {
        const nextSnap = ordered.findIndex((x, j) => j > i && x.kind === 'snapshot')
        if (nextSnap === -1) break
        i = nextSnap - 1 // continue the loop at that snapshot
        continue
      }
      stock = applyUpdate(stock, m.kind, m.payload)
      lastSeq = m.seq
      applied.push({ messageId: m.messageId, seq: m.seq, kind: m.kind })
    }
    result.push({ chainId: first.chainId, storeId: first.storeId, stock, version: applied.length, lastSeq, applied })
  }
  return result
}
