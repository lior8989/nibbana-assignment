// Worker process entry point (one of the 4 OS processes started by src/main.ts).
// Exit codes: 0 = no work left; 143 = stopped by SIGTERM/SIGINT (non-zero on purpose, so the
// supervisor restarts a worker that was killed from outside); 1 = unexpected error.
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { Worker } from './worker/worker.js'

const MAX_CONCURRENT_STORES = 8

const workerId = String(process.pid)
const log = (msg: string) => console.log(msg)
// One connection per concurrent store transaction, plus spares for polling and claiming.
const pool = createPool(loadConfig().databaseUrl, MAX_CONCURRENT_STORES + 2)

const worker = new Worker(pool, {
  workerId,
  maxConcurrentStores: MAX_CONCURRENT_STORES,
  idlePollMs: 250,
  leaseMs: 5_000,
  maxFailures: 5,
  failureBackoffMs: 1_000,
  log,
})

let signalled = false
const onSignal = () => {
  signalled = true
  worker.stop()
}
process.once('SIGTERM', onSignal)
process.once('SIGINT', onSignal)

let code = 0
try {
  log(`[worker ${workerId}] slot ${process.env.WORKER_SLOT ?? '?'} started`)
  await worker.run()
  code = signalled ? 143 : 0
} catch (err) {
  log(`[worker ${workerId}] fatal: ${err instanceof Error ? err.stack : String(err)}`)
  code = 1
} finally {
  await pool.end().catch(() => {})
}
const { steps, storesProcessed, failures } = worker.stats
log(`[worker ${workerId}] exit ${code} — stores=${storesProcessed} steps=${JSON.stringify(steps)} failures=${failures}`)
process.exit(code)
