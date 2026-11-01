import { describe, expect, it } from 'vitest'
import { DEFAULT_DATABASE_URL, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('uses DATABASE_URL when set', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x/y' }).databaseUrl).toBe('postgres://x/y')
  })

  it('falls back to the default when DATABASE_URL is unset or empty', () => {
    expect(loadConfig({}).databaseUrl).toBe(DEFAULT_DATABASE_URL)
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBe(DEFAULT_DATABASE_URL)
  })
})
