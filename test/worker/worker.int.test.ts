import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from '../../src/db/pool.js'
import { runMigrations } from '../../src/db/migrate.js'
import { reconcile } from '../../src/verify/check.js'
import { Worker, type WorkerSettings } from '../../src/worker/worker.js'
import { createTestDb } from '../helpers/testDb.js'
import { insertMessages, newStore, outcomes } from '../helpers/fixtures.js'

const SEED_JS = path.resolve(import.meta.dirname, '../../seed.js')

let db: Awaited<ReturnType<typeof createTestDb>>

beforeAll(async () => {
  db = await createTestDb('worker')
  await runMigrations(db.pool)
})
afterAll(async () => db?.drop())

const settings = (workerId: string): WorkerSettings => ({
  workerId,
  maxConcurrentStores: 8,
  idlePollMs: 50,
  leaseMs: 5_000,
  maxFailures: 3,
  failureBackoffMs: 50,
})

/** Runs `n` workers concurrently, each with its own pool (as separate processes would). */
async function runFleet(n: number) {
  const pools = Array.from({ length: n }, () => createPool(db.url, 10))
  try {
    const workers = pools.map((p, i) => new Worker(p, settings(`w${i}`)))
    const done = await Promise.all(workers.map((w) => w.run()))
    return { done, workers }
  } finally {
    await Promise.all(pools.map((p) => p.end()))
  }
}

describe('Worker fleet', () => {
  it('drains real seed data (with a poisoned receipt) correctly with 4 concurrent workers', async () => {
    await promisify(execFile)(process.execPath, [SEED_JS, '--poison'], {
      env: { ...process.env, DATABASE_URL: db.url, SEED: '11' },
    })
    // Keep the "receipt still uploading" path, but shorten the wait so the test is fast.
    await db.pool.query(`UPDATE receipt_files SET ready_at = now() + interval '2 seconds' WHERE ready_at > now()`)

    const { done, workers } = await runFleet(4)

    expect(done).toEqual([true, true, true, true])
    expect(await reconcile(db.pool)).toEqual([])
    // Work was actually shared between the workers.
    expect(workers.filter((w) => w.stats.steps.progressed > 0).length).toBeGreaterThan(1)
  }, 60_000)

  it('sets aside a store whose messages keep failing, and still finishes', async () => {
    await db.pool.query('TRUNCATE queue_messages, receipt_files, store_stock, apply_log, store_claims CASCADE')
    const good = newStore()
    const bad = newStore()
    await insertMessages(db.pool, good, [{ seq: 1, kind: 'snapshot', payload: { stock: { a: 1 } } }])
    await insertMessages(db.pool, bad, [{ seq: 1, kind: 'snapshot', payload: { stock: 'not-an-object' } }])

    const { done, workers } = await runFleet(2)

    expect(done).toEqual([true, true])
    expect(await outcomes(db.pool, good)).toEqual(['1:applied'])
    expect(await outcomes(db.pool, bad)).toEqual(['1:pending'])
    expect(workers.reduce((n, w) => n + w.stats.failures, 0)).toBe(3) // maxFailures attempts
    const { rows } = await db.pool.query(`SELECT failures, last_error FROM store_claims WHERE store_id = $1`, [bad.storeId])
    expect(rows[0]).toMatchObject({ failures: 3, last_error: expect.stringContaining('snapshot.stock') })
  }, 30_000)
})
