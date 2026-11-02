import type { UpdateKind } from './stock.js'

/** Upload state of a message's receipt file, evaluated against the DB clock. */
export type ReceiptState = 'ready' | 'pending' | 'failed'

/** A store's head: its lowest-seq message that has not been processed yet. */
export interface HeadMessage {
  readonly seq: number
  readonly kind: UpdateKind
  readonly receipt: ReceiptState
}

/** What to do with a store's head message. */
export type Decision =
  /** seq already covered by the store (retransmit, or overtaken by a snapshot): mark processed, don't apply. */
  | { readonly type: 'discard' }
  /** Apply it to store_stock and log it. */
  | { readonly type: 'apply' }
  /** Receipt upload not finished yet: try again later. */
  | { readonly type: 'wait' }
  /** Receipt failed for good, but a later snapshot restores the full stock: skip everything before it. */
  | { readonly type: 'skip-to-snapshot'; readonly snapshotSeq: number }
  /** Cannot progress in this run (failed receipt with no later snapshot, or a missing seq). */
  | { readonly type: 'blocked'; readonly reason: 'receipt-failed' | 'missing-seq' }

/**
 * Decides how to handle a store's head message (pure; the core processing rules).
 *
 * Rules, in order:
 * 1. `seq <= lastSeq` → discard: that position is already applied or superseded.
 * 2. A delta must be exactly `lastSeq + 1`; a snapshot may jump ahead, because it carries the
 *    complete stock and every earlier pending message has already been processed or is absent.
 *    A delta after a gap → blocked (missing-seq).
 * 3. Receipt ready → apply; still uploading → wait.
 * 4. Receipt failed → skip to the next pending snapshot if one exists, else blocked.
 *
 * NOTE: `storeStatesSql` in src/worker/queries.ts mirrors these rules in SQL to find work;
 * keep the two in sync.
 *
 * @param lastSeq - The store's `store_stock.last_seq` (0 if the store has no row yet).
 * @param nextSnapshotSeq - Seq of the store's next pending snapshot after the head, or null.
 */
export function decideNext(head: HeadMessage, lastSeq: number, nextSnapshotSeq: number | null): Decision {
  if (head.seq <= lastSeq) return { type: 'discard' }
  if (head.kind === 'delta' && head.seq !== lastSeq + 1) return { type: 'blocked', reason: 'missing-seq' }
  if (head.receipt === 'ready') return { type: 'apply' }
  if (head.receipt === 'pending') return { type: 'wait' }
  return nextSnapshotSeq === null
    ? { type: 'blocked', reason: 'receipt-failed' }
    : { type: 'skip-to-snapshot', snapshotSeq: nextSnapshotSeq }
}
