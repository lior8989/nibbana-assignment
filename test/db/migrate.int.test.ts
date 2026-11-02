import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { runMigrations } from '../../src/db/migrate.js'
import { createTestDb } from '../helpers/testDb.js'

let db: Awaited<ReturnType<typeof createTestDb>>
let pool: pg.Pool

beforeAll(async () => {
  db = await createTestDb('migrate')
  pool = db.pool
})
afterAll(async () => db?.drop())

describe('runMigrations', () => {
  it('applies every migration once even when started concurrently', async () => {
    const results = await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)])
    expect(results.flat().sort()).toEqual(['001_processing_state.sql', '002_claim_failures.sql'])
    expect(await runMigrations(pool)).toEqual([])
  })

  it('adds the processing columns and the store_claims table', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'queue_messages' AND column_name IN ('processed_at', 'outcome'))
         OR table_name = 'store_claims'`)
    const cols = rows.map((r) => `${r.table_name}.${r.column_name}`).sort()
    expect(cols).toEqual([
      'queue_messages.outcome',
      'queue_messages.processed_at',
      'store_claims.chain_id',
      'store_claims.failures',
      'store_claims.last_error',
      'store_claims.locked_by',
      'store_claims.locked_until',
      'store_claims.store_id',
    ])
  })

  it('rejects an invalid outcome value', async () => {
    await pool.query(`INSERT INTO receipt_files (id, ready_at) VALUES (gen_random_uuid(), now())`)
    await expect(
      pool.query(`
        INSERT INTO queue_messages (message_id, chain_id, store_id, seq, kind, payload, receipt_id, outcome)
        SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'delta', '{}', id, 'bogus'
        FROM receipt_files LIMIT 1`),
    ).rejects.toThrow(/check constraint/)
  })

  it('makes apply_log reject logging the same update twice', async () => {
    const insert = `
      INSERT INTO apply_log (message_id, chain_id, store_id, seq, kind, worker_id)
      VALUES ($1, $2, $3, $4, 'delta', 'w1')`
    const [m, c, s, m2] = ['a', 'b', 'c', 'd'].map((x) => `${x.repeat(8)}-0000-4000-8000-000000000000`)
    await pool.query(insert, [m, c, s, 1])
    // same message_id again
    await expect(pool.query(insert, [m, c, s, 2])).rejects.toThrow(/apply_log_message_id_uq/)
    // same store + seq under a different message_id
    await expect(pool.query(insert, [m2, c, s, 1])).rejects.toThrow(/apply_log_store_seq_uq/)
  })
})
