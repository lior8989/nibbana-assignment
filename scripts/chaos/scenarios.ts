import { isAlive, sleep, startApp, waitFor, type AppRun } from './app.js'

/** What a scenario needs from the runner. */
export interface ChaosContext {
  /** Starts a fresh app instance (output appended to the scenario's log file). */
  startApp(): AppRun
}

/**
 * One chaos experiment (Strategy): how to seed, and what to do to the running system.
 * `run` must return the exit code of the app instance that finished the work.
 */
export interface Scenario {
  readonly name: string
  readonly description: string
  readonly seed: number
  readonly poison: boolean
  run(ctx: ChaosContext): Promise<number | null>
}

const WORKER_COUNT = 4

/** Waits until all 4 workers of `app` are up, then a little longer so work is in flight. */
async function whenBusy(app: AppRun, extraMs: number): Promise<void> {
  await waitFor(() => app.workerPids.size >= WORKER_COUNT, 15_000, '4 workers to start')
  await sleep(extraMs)
}

const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

export const scenarios: Scenario[] = [
  {
    name: 'baseline',
    description: 'normal run, no interference',
    seed: 42,
    poison: false,
    run: (ctx) => ctx.startApp().exited,
  },
  {
    name: 'poison-other-seed',
    description: 'different SEED with a receipt that never uploads',
    seed: 7,
    poison: true,
    run: (ctx) => ctx.startApp().exited,
  },
  {
    name: 'kill-one-worker',
    description: 'SIGKILL one worker mid-run; supervisor restarts it',
    seed: 1234,
    poison: false,
    async run(ctx) {
      const app = ctx.startApp()
      await whenBusy(app, 1_500)
      kill(app.liveWorkers()[0]!)
      return app.exited
    },
  },
  {
    name: 'kill-workers-repeatedly',
    description: 'SIGKILL a random live worker every second, 6 times (with poison)',
    seed: 99,
    poison: true,
    async run(ctx) {
      const app = ctx.startApp()
      await whenBusy(app, 500)
      for (let i = 0; i < 6; i++) {
        const live = app.liveWorkers()
        if (live.length) kill(live[Math.floor(Math.random() * live.length)]!)
        await sleep(1_000)
      }
      return app.exited
    },
  },
  {
    name: 'restart-whole-app',
    description: 'SIGKILL supervisor and all workers mid-run, then start the app again',
    seed: 42,
    poison: false,
    async run(ctx) {
      const first = ctx.startApp()
      await whenBusy(first, 2_000)
      first.liveWorkers().forEach(kill)
      kill(first.supervisor.pid!)
      await first.exited
      await waitFor(() => first.liveWorkers().length === 0, 10_000, 'killed workers to exit')
      return ctx.startApp().exited
    },
  },
  {
    name: 'orphaned-workers',
    description: 'SIGKILL only the supervisor (its workers keep running), then start a second app alongside them',
    seed: 5,
    poison: true,
    async run(ctx) {
      const first = ctx.startApp()
      await whenBusy(first, 1_500)
      const orphans = first.liveWorkers()
      kill(first.supervisor.pid!)
      const code = await ctx.startApp().exited
      // The orphans are not ours to supervise; wait for them to finish on their own.
      await waitFor(() => orphans.every((p) => !isAlive(p)), 60_000, 'orphaned workers to exit')
      return code
    },
  },
]

export { startApp }
