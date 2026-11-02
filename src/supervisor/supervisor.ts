/** The parts of a child process the supervisor relies on (lets tests pass fakes). */
export interface WorkerHandle {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * Starts one worker process.
 *
 * @param slot - Fixed position 0..workers-1; a restarted worker keeps its slot.
 * @param attempt - 0 for the first start of a slot, incremented on each restart.
 */
export type SpawnWorker = (slot: number, attempt: number) => WorkerHandle

/** Supervisor tuning. */
export interface SupervisorOptions {
  /** Number of worker processes kept running (the assignment requires exactly 4). */
  readonly workers: number
  /** Total restarts allowed across all slots; guards against an endless crash loop. */
  readonly maxRestarts: number
  /** Pause before restarting a crashed worker, so a crash loop does not spin the CPU. */
  readonly restartDelayMs: number
  readonly log?: (msg: string) => void
}

type SlotState = 'running' | 'restarting' | 'done' | 'failed' | 'stopped'

/**
 * Keeps a fixed fleet of worker processes alive until they all finish (Supervisor pattern).
 *
 * - A worker exiting with code 0 has finished: its slot is done and is not restarted.
 * - A worker that crashes (non-zero code or killed by a signal) is restarted in the same
 *   slot, up to `maxRestarts` in total. Correctness never depends on this: all progress is
 *   in Postgres, so a restarted worker simply resumes from the database.
 * - `run()` resolves with 0 once every slot is done, or 1 if a slot ran out of restarts
 *   or the fleet was shut down before finishing.
 */
export class Supervisor {
  private readonly states: SlotState[] = []
  private readonly children: Array<WorkerHandle | undefined> = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private restartsUsed = 0
  private shuttingDown = false
  private resolveRun?: (code: number) => void

  constructor(
    private readonly spawn: SpawnWorker,
    private readonly opts: SupervisorOptions,
  ) {}

  /** Starts all workers. @returns The process exit code once the fleet has finished. */
  run(): Promise<number> {
    return new Promise((resolve) => {
      this.resolveRun = resolve
      for (let slot = 0; slot < this.opts.workers; slot++) this.start(slot, 0)
    })
  }

  /**
   * Stops the fleet: cancels pending restarts and sends `signal` to every running worker.
   * `run()` resolves once they have all exited.
   */
  shutdown(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.log(`shutting down (${signal})`)
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.states.forEach((state, slot) => {
      if (state === 'restarting') this.states[slot] = 'stopped'
      if (state === 'running') this.children[slot]?.kill(signal)
    })
    this.maybeFinish()
  }

  private start(slot: number, attempt: number): void {
    const child = this.spawn(slot, attempt)
    this.children[slot] = child
    this.states[slot] = 'running'
    child.once('exit', (code, signal) => this.onExit(slot, attempt, code, signal))
  }

  private onExit(slot: number, attempt: number, code: number | null, signal: NodeJS.Signals | null): void {
    this.children[slot] = undefined
    const how = signal ? `signal ${signal}` : `code ${code}`

    if (this.shuttingDown) {
      this.states[slot] = 'stopped'
    } else if (code === 0) {
      this.states[slot] = 'done'
      this.log(`worker slot ${slot} finished`)
    } else if (this.restartsUsed < this.opts.maxRestarts) {
      this.restartsUsed++
      this.states[slot] = 'restarting'
      this.log(`worker slot ${slot} exited (${how}); restarting (${this.restartsUsed}/${this.opts.maxRestarts})`)
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.start(slot, attempt + 1)
      }, this.opts.restartDelayMs)
      this.timers.add(timer)
    } else {
      this.states[slot] = 'failed'
      this.log(`worker slot ${slot} exited (${how}); restart limit reached`)
    }
    this.maybeFinish()
  }

  private maybeFinish(): void {
    if (this.states.some((s) => s === 'running' || s === 'restarting')) return
    const ok = !this.shuttingDown && this.states.every((s) => s === 'done')
    this.resolveRun?.(ok ? 0 : 1)
    this.resolveRun = undefined
  }

  private log(msg: string): void {
    this.opts.log?.(`[supervisor] ${msg}`)
  }
}
