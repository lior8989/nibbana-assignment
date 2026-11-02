import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { runMigrations } from '../../src/db/migrate.js'
import * as q from '../../src/worker/queries.js'
import { processStep, type StepResult } from '../../src/worker/step.js'
import { createTestDb } from '../helpers/testDb.js'
import { getStock, insertMessages, loggedSeqs, newStore, outcomes } from '../helpers/fixtures.js'

const cfg: q.ClaimSettings = { leaseMs: 5_000, maxFailures: 3 }
const W = 'worker-a'

let db: Awaited<ReturnType<typeof createTestDb>>
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDb('step')
  pool = db.pool
  await runMigrations(pool)
})
afterAll(async () => db?.drop())
beforeEach(async () => {
  await pool.query('TRUNCATE queue_messages, receipt_files, store_stock, apply_log, store_claims CASCADE')
})

/** Claims the store, runs steps until it stops progressing, releases it; returns every step result. */
async function drain(store: q.StoreKey, worker = W): Promise<StepResult[]> {
  expect(await q.tryClaim(pool, store, worker, cfg)).toBe(true)
  const results: StepResult[] = []
  let r: StepResult
  do {
    r = await processStep(pool, store, worker, cfg)
    results.push(r)
  } while (r === 'progressed')
  await q.releaseClaim(pool, store, worker)
  return results
}

describe('processStep', () => {
  it('applies messages in seq order regardless of arrival order, and applies retransmits once', async () => {
    const s = newStore()
    const [d3] = await insertMessages(pool, s, [{ seq: 3, kind: 'delta', payload: { unset: ['eggs'] } }])
    await insertMessages(pool, s, [
      { seq: 2, kind: 'delta', payload: { set: { milk: 12 } } },
      { seq: 1, kind: 'snapshot', payload: { stock: { milk: 10, eggs: 6 } } },
      { seq: 3, kind: 'delta', payload: { unset: ['eggs'] }, messageId: d3 }, // retransmit
    ])

    expect(await drain(s)).toEqual(['progressed', 'progressed', 'progressed', 'idle'])
    expect(await getStock(pool, s)).toEqual({ stock: { milk: 12 }, version: 3, last_seq: 3 })
    expect(await loggedSeqs(pool, s)).toEqual([1, 2, 3])
    expect(await outcomes(pool, s)).toEqual(['1:applied', '2:applied', '3:applied', '3:duplicate'])
  })

  it('discards a retransmit that arrives after its update was applied', async () => {
    const s = newStore()
    const [id] = await insertMessages(pool, s, [{ seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } }])
    await drain(s)
    await insertMessages(pool, s, [{ seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } }, messageId: id }])

    expect(await drain(s)).toEqual(['progressed', 'idle'])
    expect(await outcomes(pool, s)).toEqual(['1:applied', '1:duplicate'])
    expect(await loggedSeqs(pool, s)).toEqual([1])
  })

  it('waits on a pending receipt without writing anything, then applies once it is ready', async () => {
    const s = newStore()
    await insertMessages(pool, s, [
      { seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } },
      { seq: 2, kind: 'delta', payload: { set: { a: 2 } }, receipt: 'pending' },
      { seq: 3, kind: 'delta', payload: { set: { a: 3 } } },
    ])
    expect(await drain(s)).toEqual(['progressed', 'waiting'])
    expect((await getStock(pool, s))?.last_seq).toBe(1)
    expect(await q.hasRemainingWork(pool, cfg)).toBe(true)

    await pool.query(`UPDATE receipt_files SET ready_at = now() WHERE ready_at > now()`)
    expect(await drain(s)).toEqual(['progressed', 'progressed', 'idle'])
    expect(await getStock(pool, s)).toMatchObject({ stock: { a: 3 }, last_seq: 3 })
  })

  it('is blocked on a failed receipt with no later snapshot, and the run counts as complete', async () => {
    const s = newStore()
    await insertMessages(pool, s, [
      { seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } },
      { seq: 2, kind: 'delta', payload: { set: { a: 2 } }, receipt: 'failed' },
      { seq: 3, kind: 'delta', payload: { set: { a: 3 } } },
    ])
    expect(await drain(s)).toEqual(['progressed', 'blocked'])
    expect(await getStock(pool, s)).toMatchObject({ stock: { a: 1 }, last_seq: 1 })
    expect(await q.hasRemainingWork(pool, cfg)).toBe(false)
  })

  it('skips from a failed receipt to the next snapshot; skipped messages are never logged', async () => {
    const s = newStore()
    await insertMessages(pool, s, [
      { seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } },
      { seq: 2, kind: 'delta', payload: { set: { a: 2 } }, receipt: 'failed' },
      { seq: 3, kind: 'delta', payload: { set: { a: 3 } } },
      { seq: 4, kind: 'snapshot', payload: { stock: { b: 1 } } },
      { seq: 5, kind: 'delta', payload: { set: { b: 2 } } },
    ])
    expect(await drain(s)).toEqual(['progressed', 'progressed', 'progressed', 'progressed', 'idle'])
    expect(await getStock(pool, s)).toEqual({ stock: { b: 2 }, version: 3, last_seq: 5 })
    expect(await loggedSeqs(pool, s)).toEqual([1, 4, 5])
    expect(await outcomes(pool, s)).toEqual(['1:applied', '2:superseded', '3:superseded', '4:applied', '5:applied'])
  })

  it('stops writing once another worker has taken the store over (lease fence)', async () => {
    const s = newStore()
    await insertMessages(pool, s, [{ seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } }])
    await q.tryClaim(pool, s, W, cfg)
    await pool.query(`UPDATE store_claims SET locked_by = 'worker-b'`) // W's lease expired and B took over

    expect(await processStep(pool, s, W, cfg)).toBe('lost-claim')
    expect(await getStock(pool, s)).toBeUndefined()
    expect(await outcomes(pool, s)).toEqual(['1:pending'])
  })

  it('writes nothing at all when any part of the transaction fails', async () => {
    const s = newStore()
    const [id] = await insertMessages(pool, s, [{ seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } }])
    // Force the apply_log insert to fail (unique message_id) after store_stock was already written.
    await pool.query(
      `INSERT INTO apply_log (message_id, chain_id, store_id, seq, kind, worker_id) VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, 'snapshot', 'x')`,
      [id],
    )
    await q.tryClaim(pool, s, W, cfg)

    await expect(processStep(pool, s, W, cfg)).rejects.toThrow(/apply_log_message_id_uq/)
    expect(await getStock(pool, s)).toBeUndefined()
    expect(await outcomes(pool, s)).toEqual(['1:pending'])
  })
})

describe('claims', () => {
  it('lets exactly one of many concurrent workers claim a store', async () => {
    const s = newStore()
    const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => q.tryClaim(pool, s, `w${i}`, cfg)))
    expect(wins.filter(Boolean)).toHaveLength(1)
  })

  it('allows taking over an expired lease', async () => {
    const s = newStore()
    await q.tryClaim(pool, s, 'w1', cfg)
    expect(await q.tryClaim(pool, s, 'w2', cfg)).toBe(false)
    await pool.query(`UPDATE store_claims SET locked_until = now() - interval '1 second'`)
    expect(await q.tryClaim(pool, s, 'w2', cfg)).toBe(true)
  })

  it('findClaimableStores skips claimed, waiting and set-aside stores', async () => {
    const [ready, claimed, waiting, setAside] = [newStore(), newStore(), newStore(), newStore()]
    for (const s of [ready, claimed, setAside]) await insertMessages(pool, s, [{ seq: 1, kind: 'snapshot', payload: { stock: {} } }])
    await insertMessages(pool, waiting, [{ seq: 1, kind: 'snapshot', payload: { stock: {} }, receipt: 'pending' }])
    await q.tryClaim(pool, claimed, 'other', cfg)
    await q.tryClaim(pool, setAside, 'other', cfg)
    await pool.query(`UPDATE store_claims SET failures = $1, locked_by = NULL, locked_until = NULL WHERE store_id = $2`, [
      cfg.maxFailures,
      setAside.storeId,
    ])

    expect(await q.findClaimableStores(pool, 10, cfg)).toEqual([ready])
  })
})
