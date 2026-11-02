import { describe, expect, it } from 'vitest'
import { applyUpdate, InvalidPayloadError } from '../../src/domain/stock.js'

describe('applyUpdate', () => {
  const base = { milk: 10, eggs: 6, bread: 3 }

  it('snapshot replaces the whole stock', () => {
    expect(applyUpdate(base, 'snapshot', { stock: { tomato: 80 } })).toEqual({ tomato: 80 })
  })

  it('delta sets final values and adds new items', () => {
    expect(applyUpdate(base, 'delta', { set: { eggs: 4, apple: 20 } })).toEqual({ milk: 10, eggs: 4, bread: 3, apple: 20 })
  })

  it('delta unsets items, ignoring ones that are not there', () => {
    expect(applyUpdate(base, 'delta', { unset: ['bread', 'nope'] })).toEqual({ milk: 10, eggs: 6 })
  })

  it('when a delta sets and unsets the same item, unset wins', () => {
    expect(applyUpdate(base, 'delta', { set: { milk: 12 }, unset: ['milk'] })).toEqual({ eggs: 6, bread: 3 })
  })

  it('keeps non-numeric values as-is', () => {
    expect(applyUpdate({}, 'delta', { set: { promo_code: 'v2.4' } })).toEqual({ promo_code: 'v2.4' })
  })

  it('treats a missing set/unset as empty', () => {
    expect(applyUpdate(base, 'delta', {})).toEqual(base)
  })

  it('never mutates the input stock', () => {
    const input = { ...base }
    applyUpdate(input, 'delta', { set: { milk: 1 }, unset: ['eggs'] })
    applyUpdate(input, 'snapshot', { stock: {} })
    expect(input).toEqual(base)
  })

  it.each([
    ['snapshot', null],
    ['snapshot', { stock: [] }],
    ['delta', { set: [1] }],
    ['delta', { unset: 'milk' }],
    ['delta', { unset: [1] }],
  ] as const)('rejects invalid %s payload %j', (kind, payload) => {
    expect(() => applyUpdate(base, kind, payload)).toThrow(InvalidPayloadError)
  })
})
