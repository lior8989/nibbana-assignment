import { decideNext } from '../domain/decide.js'
import { applyUpdate } from '../domain/stock.js'
import { withTransaction, type ClientSource } from '../db/transaction.js'
import * as q from './queries.js'

/**
 * Outcome of one step on a store:
 * - progressed: a message was applied, discarded, or skipped — call again for the next one
 * - waiting / blocked / idle: nothing more to do on this store for now
 * - lost-claim: another worker owns the store now; stop touching it
 */
export type StepResult = 'progressed' | 'waiting' | 'blocked' | 'idle' | 'lost-claim'

/**
 * Handles the store's next message in ONE transaction: verify and renew the claim, read the
 * store state and head message, decide (see `decideNext`), and write the outcome. Either all
 * writes commit together (store_stock + apply_log + queue status + lease) or none do, so a
 * crash at any point leaves the database consistent and the step is simply redone.
 */
export async function processStep(
  pool: ClientSource,
  key: q.StoreKey,
  workerId: string,
  cfg: q.ClaimSettings,
): Promise<StepResult> {
  return withTransaction(pool, async (db) => {
    if (!(await q.renewClaim(db, key, workerId, cfg))) return 'lost-claim'

    const head = await q.loadHead(db, key)
    if (!head) return 'idle'
    const state = await q.loadStoreState(db, key)
    const nextSnapshotSeq = head.receipt === 'failed' ? await q.findNextSnapshotSeq(db, key, head.seq) : null

    const decision = decideNext(head, state.lastSeq, nextSnapshotSeq)
    switch (decision.type) {
      case 'apply':
        await q.applyMessage(db, key, head, applyUpdate(state.stock, head.kind, head.payload), workerId)
        return 'progressed'
      case 'discard':
        await q.discardMessage(db, head)
        return 'progressed'
      case 'skip-to-snapshot':
        await q.supersedeRange(db, key, head.seq, decision.snapshotSeq)
        return 'progressed'
      case 'wait':
        return 'waiting'
      case 'blocked':
        return 'blocked'
    }
  })
}
