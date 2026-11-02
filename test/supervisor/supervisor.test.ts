import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Supervisor, type SupervisorOptions, type WorkerHandle } from '../../src/supervisor/supervisor.js'

/** Fake worker process: the test decides when and how it exits. */
class FakeWorker extends EventEmitter implements WorkerHandle {
  killedWith?: NodeJS.Signals
  constructor(
    readonly slot: number,
    readonly attempt: number,
  ) {
    super()
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killedWith = signal
    queueMicrotask(() => this.exit(null, signal))
    return true
  }
}

function setup(opts: Partial<SupervisorOptions> = {}) {
  const spawned: FakeWorker[] = []
  const supervisor = new Supervisor(
    (slot, attempt) => {
      const w = new FakeWorker(slot, attempt)
      spawned.push(w)
      return w
    },
    { workers: 4, maxRestarts: 3, restartDelayMs: 0, ...opts },
  )
  const latest = (slot: number) => spawned.filter((w) => w.slot === slot).at(-1)!
  return { supervisor, spawned, latest }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('Supervisor', () => {
  it('starts exactly the configured number of workers', () => {
    const { supervisor, spawned } = setup()
    void supervisor.run()
    expect(spawned.map((w) => [w.slot, w.attempt])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ])
  })

  it('resolves 0 once every worker exits with code 0', async () => {
    const { supervisor, spawned } = setup()
    const run = supervisor.run()
    spawned.forEach((w) => w.exit(0))
    expect(await run).toBe(0)
  })

  it('restarts a killed worker in the same slot and still finishes with 0', async () => {
    const { supervisor, spawned, latest } = setup()
    const run = supervisor.run()
    spawned[1]!.exit(null, 'SIGKILL')
    await tick()
    expect(latest(1).attempt).toBe(1)
    expect(spawned).toHaveLength(5)

    for (const slot of [0, 1, 2, 3]) latest(slot).exit(0)
    expect(await run).toBe(0)
  })

  it('does not restart a worker that finished, even if others are still running', async () => {
    const { supervisor, spawned } = setup()
    void supervisor.run()
    spawned[0]!.exit(0)
    await tick()
    expect(spawned).toHaveLength(4)
  })

  it('stops restarting after maxRestarts and resolves 1', async () => {
    const { supervisor, spawned, latest } = setup({ workers: 1, maxRestarts: 2 })
    const run = supervisor.run()
    for (let i = 0; i < 3; i++) {
      latest(0).exit(1)
      await tick()
    }
    expect(spawned).toHaveLength(3) // first start + 2 restarts
    expect(await run).toBe(1)
  })

  it('shutdown signals running workers, cancels pending restarts and resolves 1', async () => {
    const { supervisor, spawned } = setup({ restartDelayMs: 1000 })
    const run = supervisor.run()
    spawned[0]!.exit(1) // restart pending for 1s
    supervisor.shutdown('SIGTERM')
    expect(spawned.slice(1).every((w) => w.killedWith === 'SIGTERM')).toBe(true)
    expect(await run).toBe(1)
    expect(spawned).toHaveLength(4) // pending restart was cancelled
  })
})
