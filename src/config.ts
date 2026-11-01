/** Default connection string; matches the one used by `seed.js` and docker-compose. */
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5439/stockstream'

/** Runtime configuration shared by the supervisor and the workers. */
export interface AppConfig {
  /** Postgres connection string. */
  readonly databaseUrl: string
}

/**
 * Builds the app configuration from environment variables.
 *
 * @param env - Environment to read from; injectable for tests.
 * @returns The resolved configuration, falling back to defaults for unset values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL || DEFAULT_DATABASE_URL,
  }
}
