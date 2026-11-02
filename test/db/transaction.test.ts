import { describe, expect, it } from 'vitest'
import { withTransaction, type ClientSource } from '../../src/db/transaction.js'

/** Fake pool that records every query and how the client was released. */
function fakeSource(opts: { failOn?: string } = {}) {
  const queries: string[] = []
  const released: Array<Error | boolean | undefined> = []
  const source = {
    async connect() {
      return {
        async query(sql: string) {
          queries.push(sql)
          if (sql === opts.failOn) throw new Error(`boom on ${sql}`)
          return { rows: [] }
        },
        release(err?: Error | boolean) {
          released.push(err)
        },
      }
    },
  } as unknown as ClientSource
  return { source, queries, released }
}

describe('withTransaction', () => {
  it('commits and returns the result when work succeeds', async () => {
    const { source, queries, released } = fakeSource()
    const result = await withTransaction(source, async (c) => {
      await c.query('SELECT 1')
      return 42
    })
    expect(result).toBe(42)
    expect(queries).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
    expect(released).toEqual([undefined])
  })

  it('rolls back and rethrows when work fails', async () => {
    const { source, queries, released } = fakeSource()
    await expect(
      withTransaction(source, async () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow('work failed')
    expect(queries).toEqual(['BEGIN', 'ROLLBACK'])
    expect(released).toEqual([undefined])
  })

  it('rolls back when COMMIT itself fails', async () => {
    const { source, queries } = fakeSource({ failOn: 'COMMIT' })
    await expect(withTransaction(source, async () => 1)).rejects.toThrow('boom on COMMIT')
    expect(queries).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK'])
  })

  it('destroys the client when ROLLBACK fails, and rethrows the original error', async () => {
    const { source, released } = fakeSource({ failOn: 'ROLLBACK' })
    await expect(
      withTransaction(source, async () => {
        throw new Error('original')
      }),
    ).rejects.toThrow('original')
    expect(released[0]).toBeInstanceOf(Error)
  })
})
