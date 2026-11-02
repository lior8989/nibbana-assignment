import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { loadConfig } from '../../src/config.js'
import { createPool } from '../../src/db/pool.js'

const SCHEMA_SQL = path.resolve(import.meta.dirname, '../../schema.sql')

/** Builds a connection string pointing at `database` on the configured server. */
function urlFor(database: string): string {
  const url = new URL(loadConfig().databaseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

/**
 * Creates a fresh, isolated database (dropped first if it exists) with the provided
 * `schema.sql` applied, so integration tests never touch the seeded dev database.
 * Each test file must use its own `name` because Vitest runs files in parallel.
 *
 * @returns A pool on the new database and a `drop` function for cleanup.
 */
export async function createTestDb(name: string): Promise<{ pool: pg.Pool; url: string; drop: () => Promise<void> }> {
  const database = `stockstream_test_${name}`
  const admin = new pg.Client({ connectionString: urlFor('postgres') })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${database}`)
  } finally {
    await admin.end()
  }

  const url = urlFor(database)
  const pool = createPool(url, 10)
  await pool.query(await fs.readFile(SCHEMA_SQL, 'utf8'))

  return {
    pool,
    url,
    drop: async () => {
      await pool.end()
      const c = new pg.Client({ connectionString: urlFor('postgres') })
      await c.connect()
      try {
        await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      } finally {
        await c.end()
      }
    },
  }
}
