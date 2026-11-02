// CLI (`npm run verify`): reconciles store_stock and apply_log against an independent
// replay of the queue. Exit 0 = correct, 1 = problems found (they are printed).
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { reconcile } from './verify/check.js'

const pool = createPool(loadConfig().databaseUrl, 1)
try {
  const problems = await reconcile(pool)
  const { rows } = await pool.query<{ outcome: string | null; n: number }>(
    `SELECT outcome, count(*)::int AS n FROM queue_messages GROUP BY outcome ORDER BY outcome`,
  )
  console.log('queue outcomes:', Object.fromEntries(rows.map((r) => [r.outcome ?? 'unprocessed', r.n])))
  if (problems.length === 0) {
    console.log('verify: OK — store_stock and apply_log match the update stream')
  } else {
    console.log(`verify: ${problems.length} problem(s)`)
    for (const p of problems.slice(0, 50)) console.log(`  - ${p}`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
