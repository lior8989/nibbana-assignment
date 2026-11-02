import type pg from 'pg'
import * as q from './queries.js'
import { processStep, type StepResult } from './step.js'

/** Worker tuning. */
export interface WorkerSettings extends q.ClaimSettings {
  /** Identifies this worker in claims and apply_log (the OS PID in production). */
  readonly workerId: string
  /** Max stores processed concurrently by this worker (async, one transaction each). */
  readonly maxConcurrentStores: number
  /** Sleep between polls when there is nothing to claim. */
  readonly idlePollMs: number
  /** How long a failed store stays unclaimable before it is retried. */
  readonly failureBackoffMs: number
  readonly log?: (msg: string) => void
}

/** Counters reported when the worker stops. */
export interface WorkerStats {
  steps: Record<StepResult, number>
  storesProcessed: number
  failures: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * One worker process's scheduling loop.
 *
 * Repeatedly claims free stores that have work and processes up to `maxConcurrentStores`
 * of them at once. Each store is drained message by message (one transaction each) until
 * it has to wait or is blocked, then released so any worker can pick it up later — so a
 * slow or broken store never holds a worker. Stops when the database reports no remaining
 * work (see `hasRemainingWork`) or when `stop()` is called.
 */
export class Worker {
  private stopping = false
  private readonly inFlight = new Set<Promise<void>>()
  readonly stats: WorkerStats = {
    steps: { progressed: 0, waiting: 0, blocked: 0, idle: 0, 'lost-claim': 0 },
    storesProcessed: 0,
    failures: 0,
  }

  constructor(
    private readonly pool: pg.Pool,
    private readonly cfg: WorkerSettings,
  ) {}

  /** Runs until all work is done (resolves true) or `stop()` was called (resolves false). */
  async run(): Promise<boolean> {
    while (!this.stopping) {
      const free = this.cfg.maxConcurrentStores - this.inFlight.size
      const started = free > 0 ? await this.claimAndStart(free) : 0
      if (started > 0) continue

      if (this.inFlight.size > 0) {
        // Busy: wake on the first store that finishes, or poll again for new work.
        await Promise.race([...this.inFlight, sleep(this.cfg.idlePollMs)])
      } else if (await q.hasRemainingWork(this.pool, this.cfg)) {
        await sleep(this.cfg.idlePollMs) // only waiting / claimed-elsewhere work left
      } else {
        return true
      }
    }
    await Promise.all(this.inFlight)
    return false
  }

  /** Asks the loop to stop: no new stores are claimed; in-flight stores stop after their current step. */
  stop(): void {
    this.stopping = true
  }

  private async claimAndStart(free: number): Promise<number> {
    const candidates = await q.findClaimableStores(this.pool, free, this.cfg)
    let started = 0
    for (const key of candidates) {
      if (!(await q.tryClaim(this.pool, key, this.cfg.workerId, this.cfg))) continue // lost the race
      const task: Promise<void> = this.drainStore(key).finally(() => this.inFlight.delete(task))
      this.inFlight.add(task)
      started++
    }
    return started
  }

  /** Processes one claimed store until it cannot progress, then releases it. Never throws. */
  private async drainStore(key: q.StoreKey): Promise<void> {
    try {
      let result: StepResult
      do {
        result = await processStep(this.pool, key, this.cfg.workerId, this.cfg)
        this.stats.steps[result]++
      } while (result === 'progressed' && !this.stopping)

      if (result !== 'lost-claim') await q.releaseClaim(this.pool, key, this.cfg.workerId)
      this.stats.storesProcessed++
    } catch (err) {
      this.stats.failures++
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`store ${key.storeId} failed: ${msg}`)
      await q
        .recordFailure(this.pool, key, this.cfg.workerId, msg, this.cfg.failureBackoffMs)
        .catch((e: Error) => this.log(`could not record failure: ${e.message}`)) // lease expiry still frees it
    }
  }

  private log(msg: string): void {
    this.cfg.log?.(`[worker ${this.cfg.workerId}] ${msg}`)
  }
}
