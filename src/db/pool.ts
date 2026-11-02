import pg from 'pg'

/**
 * Creates a Postgres connection pool.
 *
 * @param connectionString - Postgres URL.
 * @param max - Maximum open connections; size it to the process's concurrency
 *   (one per in-flight transaction plus a spare for polling).
 */
export function createPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max })
  // An idle client can error (e.g. DB restart). Without a listener this would crash the
  // process; the pool already discards the broken client, so logging is enough.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message))
  return pool
}
