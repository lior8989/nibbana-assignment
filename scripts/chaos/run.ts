// Chaos runner (`npm run chaos [scenario...]`): for each scenario — seed, run the app while
// injecting failures, then reconcile store_stock/apply_log against an independent replay.
// Exits 1 if any scenario's app did not exit 0 or its data does not verify.
// Logs of each app run go to logs/chaos-<scenario>.log.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../src/config.js'
import { createPool } from '../../src/db/pool.js'
import { reconcile } from '../../src/verify/check.js'
import { seed, startApp } from './app.js'
import { scenarios } from './scenarios.js'

const LOG_DIR = path.resolve(import.meta.dirname, '../../logs')
fs.mkdirSync(LOG_DIR, { recursive: true })

const wanted = process.argv.slice(2)
const selected = wanted.length ? scenarios.filter((s) => wanted.includes(s.name)) : scenarios
if (selected.length === 0) {
  console.error(`unknown scenario; available: ${scenarios.map((s) => s.name).join(', ')}`)
  process.exit(2)
}

const pool = createPool(loadConfig().databaseUrl, 1)
const results: Array<{ scenario: string; exit: number | null; seconds: string; verify: string; ok: boolean }> = []

try {
  for (const s of selected) {
    const logFile = path.join(LOG_DIR, `chaos-${s.name}.log`)
    fs.rmSync(logFile, { force: true })
    console.log(`\n▶ ${s.name}: ${s.description} (SEED=${s.seed}${s.poison ? ', --poison' : ''})`)

    await seed(s.seed, s.poison)
    const started = Date.now()
    const exit = await s.run({ startApp: () => startApp(logFile) })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    const problems = await reconcile(pool)
    const ok = exit === 0 && problems.length === 0
    results.push({ scenario: s.name, exit, seconds, verify: problems.length ? `${problems.length} problem(s)` : 'OK', ok })
    console.log(`  exit=${exit} in ${seconds}s, verify: ${problems.length ? problems.slice(0, 5).join('; ') : 'OK'}`)
  }
} finally {
  await pool.end()
}

console.log()
console.table(results)
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `CHAOS: ${failed.length} scenario(s) FAILED` : 'CHAOS: all scenarios passed')
process.exit(failed.length ? 1 : 0)
