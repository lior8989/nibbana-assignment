import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTransaction, type ClientSource } from './transaction.js'

/** Default location of our own migration files (schema additions on top of schema.sql). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations')

/** Arbitrary constant key for the advisory lock that serialises concurrent migrators. */
const MIGRATION_LOCK_KEY = 74_110_001

/**
 * Applies every `*.sql` file in `dir` that has not been applied yet, in file-name order.
 *
 * All pending files run in one transaction guarded by a transaction-scoped advisory lock,
 * so concurrent starts (e.g. several app instances) cannot apply the same file twice, and
 * a failure leaves the schema unchanged. Applied files are tracked in `schema_migrations`.
 *
 * Requires the provided `schema.sql` to be applied first (done by `seed.js`).
 *
 * @returns Names of the files applied by this call (empty when already up to date).
 */
export async function runMigrations(source: ClientSource, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  return withTransaction(source, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((r) => r.name))

    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      await client.query(await fs.readFile(path.join(dir, file), 'utf8'))
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      applied.push(file)
    }
    return applied
  })
}
