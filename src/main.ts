// App entry point (`npm start`): applies our migrations, then runs the 4-worker fleet
// and exits with the fleet's exit code (0 = everything that can be done is done).
import path from 'node:path'
import { loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { spawnWorkerProcess } from './supervisor/spawn-worker.js'
import { Supervisor } from './supervisor/supervisor.js'

/** The assignment requires exactly 4 worker OS processes. */
const WORKER_COUNT = 4

const config = loadConfig()

// Migrate once here, before any worker starts, so workers can assume the schema exists.
const pool = createPool(config.databaseUrl, 1)
try {
  await runMigrations(pool)
} finally {
  await pool.end()
}

const supervisor = new Supervisor(spawnWorkerProcess(path.join(import.meta.dirname, 'worker-main.ts')), {
  workers: WORKER_COUNT,
  maxRestarts: 20,
  restartDelayMs: 500,
  log: console.log,
})
process.once('SIGINT', () => supervisor.shutdown('SIGTERM'))
process.once('SIGTERM', () => supervisor.shutdown('SIGTERM'))

const code = await supervisor.run()
console.log(`[supervisor] exiting with code ${code}`)
process.exit(code)
