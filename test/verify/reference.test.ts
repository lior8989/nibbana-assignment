import { describe, expect, it } from 'vitest'
import { replayExpected, type RefMessage } from '../../src/verify/reference.js'

let n = 0
const msg = (seq: number, kind: RefMessage['kind'], payload: unknown, receiptOk = true, messageId = `m${++n}`): RefMessage => ({
  messageId,
  chainId: 'c',
  storeId: 's',
  seq,
  kind,
  payload,
  receiptOk,
})

describe('replayExpected', () => {
  it('replays in seq order regardless of input order and ignores retransmits', () => {
    const snap = msg(1, 'snapshot', { stock: { milk: 10 } }, true, 'snap')
    const d2 = msg(2, 'delta', { set: { milk: 12 } }, true, 'd2')
    const [store] = replayExpected([d2, snap, d2])
    expect(store).toMatchObject({ stock: { milk: 12 }, version: 2, lastSeq: 2 })
    expect(store!.applied.map((a) => a.messageId)).toEqual(['snap', 'd2'])
  })

  it('stops at a failed receipt when no snapshot follows', () => {
    const [store] = replayExpected([
      msg(1, 'snapshot', { stock: { a: 1 } }),
      msg(2, 'delta', { set: { a: 2 } }, false),
      msg(3, 'delta', { set: { a: 3 } }),
    ])
    expect(store).toMatchObject({ stock: { a: 1 }, lastSeq: 1, version: 1 })
  })

  it('jumps from a failed receipt to the next snapshot', () => {
    const [store] = replayExpected([
      msg(1, 'snapshot', { stock: { a: 1 } }),
      msg(2, 'delta', { set: { a: 2 } }, false),
      msg(3, 'delta', { set: { a: 3 } }),
      msg(4, 'snapshot', { stock: { b: 1 } }),
      msg(5, 'delta', { set: { b: 2 } }),
    ])
    expect(store).toMatchObject({ stock: { b: 2 }, lastSeq: 5, version: 3 })
    expect(store!.applied.map((a) => a.seq)).toEqual([1, 4, 5])
  })

  it('stops at a missing delta seq', () => {
    const [store] = replayExpected([msg(1, 'snapshot', { stock: {} }), msg(3, 'delta', { set: { a: 1 } })])
    expect(store).toMatchObject({ lastSeq: 1, version: 1 })
  })
})
