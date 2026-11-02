import { spawn } from 'node:child_process'
import type { SpawnWorker } from './supervisor.js'

/**
 * Builds a {@link SpawnWorker} that runs `script` as a separate Node.js OS process.
 *
 * Uses `spawn` rather than `fork` on purpose: `fork` opens an IPC channel, and the
 * assignment allows Postgres as the only channel between workers. The script runs through
 * the `tsx` loader so TypeScript entry points work directly. The child gets `WORKER_SLOT`
 * and `WORKER_ATTEMPT` in its environment.
 */
export function spawnWorkerProcess(script: string, env: NodeJS.ProcessEnv = process.env): SpawnWorker {
  return (slot, attempt) =>
    spawn(process.execPath, ['--import', 'tsx', script], {
      env: { ...env, WORKER_SLOT: String(slot), WORKER_ATTEMPT: String(attempt) },
      stdio: 'inherit',
    })
}
