// CLI entry point: applies our schema additions (`npm run migrate`).
import { loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { createPool } from './db/pool.js'

const pool = createPool(loadConfig().databaseUrl, 1)
try {
  const applied = await runMigrations(pool)
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations up to date')
} finally {
  await pool.end()
}
