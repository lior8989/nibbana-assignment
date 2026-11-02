import { describe, expect, it } from 'vitest'
import { isAlive, parseWorkerStart } from '../../scripts/chaos/app.js'

describe('chaos helpers', () => {
  it('parses the worker PID from its start line only', () => {
    expect(parseWorkerStart('[worker 4242] slot 2 started')).toBe(4242)
    expect(parseWorkerStart('[worker 4242] exit 0 — stores=3')).toBeNull()
    expect(parseWorkerStart('[supervisor] worker slot 2 finished')).toBeNull()
  })

  it('reports the current process as alive and a bogus PID as not', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2 ** 22 + 12345)).toBe(false)
  })
})
