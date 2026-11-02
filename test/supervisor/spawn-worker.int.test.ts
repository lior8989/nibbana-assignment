import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnWorkerProcess } from '../../src/supervisor/spawn-worker.js'
import { Supervisor } from '../../src/supervisor/supervisor.js'

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/crash-once-worker.ts')

describe('Supervisor with real OS processes', () => {
  it('runs 4 processes, restarts the crashed one, and resolves 0', async () => {
    const logs: string[] = []
    const supervisor = new Supervisor(spawnWorkerProcess(FIXTURE), {
      workers: 4,
      maxRestarts: 5,
      restartDelayMs: 10,
      log: (m) => logs.push(m),
    })
    expect(await supervisor.run()).toBe(0)
    expect(logs.filter((l) => l.includes('restarting'))).toHaveLength(1)
    expect(logs.filter((l) => l.includes('finished'))).toHaveLength(4)
  }, 30_000)
})
