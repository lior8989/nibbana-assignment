import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Matches the worker start line printed by src/worker-main.ts. */
const WORKER_STARTED = /^\[worker (\d+)\] slot \d+ started/

/** Extracts the worker PID from a worker "started" log line, or null for any other line. */
export function parseWorkerStart(line: string): number | null {
  const m = WORKER_STARTED.exec(line)
  return m ? Number(m[1]) : null
}

/** True while an OS process with this PID exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A running instance of the app (`src/main.ts`): supervisor process + its workers. */
export interface AppRun {
  readonly supervisor: ChildProcess
  /** PIDs of every worker this run has started (including restarted ones). */
  readonly workerPids: Set<number>
  /** Resolves with the supervisor's exit code (null if it was killed by a signal). */
  readonly exited: Promise<number | null>
  /** Worker PIDs that are still running. */
  liveWorkers(): number[]
}

/**
 * Starts the app exactly as `npm start` does (without the npm wrapper, so the child PID is
 * the supervisor's) and appends its output to `logFile`.
 */
export function startApp(logFile: string): AppRun {
  const supervisor = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = fs.createWriteStream(logFile, { flags: 'a' })
  const workerPids = new Set<number>()

  let buffered = ''
  const onData = (chunk: Buffer) => {
    log.write(chunk)
    buffered += chunk.toString()
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const pid = parseWorkerStart(line)
      if (pid !== null) workerPids.add(pid)
    }
  }
  supervisor.stdout!.on('data', onData)
  supervisor.stderr!.on('data', onData)

  const exited = new Promise<number | null>((resolve) =>
    supervisor.once('exit', (code) => {
      log.end()
      resolve(code)
    }),
  )
  return {
    supervisor,
    workerPids,
    exited,
    liveWorkers: () => [...workerPids].filter(isAlive),
  }
}

/** Runs `node seed.js` with the given SEED (and `--poison` if requested). */
export function seed(seedValue: number, poison: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['seed.js', ...(poison ? ['--poison'] : [])]
    const p = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, SEED: String(seedValue) },
      stdio: 'ignore',
    })
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))))
  })
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Waits until `cond()` is true (polling), or throws after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
