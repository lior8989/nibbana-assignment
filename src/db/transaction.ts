import type pg from 'pg'

/** Minimal client surface needed inside a transaction (lets tests pass fakes). */
export type TxClient = Pick<pg.PoolClient, 'query'>

/** Anything that can hand out a dedicated client — normally a `pg.Pool`. */
export interface ClientSource {
  connect(): Promise<TxClient & { release(err?: Error | boolean): void }>
}

/**
 * Runs `work` inside a single database transaction (Unit of Work).
 *
 * Commits if `work` resolves, rolls back and rethrows if it rejects. The client is always
 * returned to the pool; if even the rollback fails, the client is destroyed instead of
 * reused, so a connection in an unknown state never leaks back into the pool.
 *
 * @param source - Pool to borrow a client from.
 * @param work - Receives the transaction's client; all its queries run in the transaction.
 * @returns Whatever `work` resolves to.
 */
export async function withTransaction<T>(
  source: ClientSource,
  work: (client: TxClient) => Promise<T>,
): Promise<T> {
  const client = await source.connect()
  let broken: Error | undefined
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      broken = rollbackErr as Error
    }
    throw err
  } finally {
    client.release(broken)
  }
}
