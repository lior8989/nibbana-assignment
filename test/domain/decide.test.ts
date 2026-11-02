import { describe, expect, it } from 'vitest'
import { decideNext, type HeadMessage } from '../../src/domain/decide.js'

const head = (seq: number, kind: HeadMessage['kind'] = 'delta', receipt: HeadMessage['receipt'] = 'ready') => ({
  seq,
  kind,
  receipt,
})

describe('decideNext', () => {
  it('applies the next contiguous message when its receipt is ready', () => {
    expect(decideNext(head(1, 'snapshot'), 0, null)).toEqual({ type: 'apply' })
    expect(decideNext(head(5), 4, null)).toEqual({ type: 'apply' })
  })

  it('discards a message whose seq is already covered (retransmit / superseded)', () => {
    expect(decideNext(head(3), 4, null)).toEqual({ type: 'discard' })
    expect(decideNext(head(4, 'snapshot'), 4, null)).toEqual({ type: 'discard' })
  })

  it('waits while the receipt upload is still pending', () => {
    expect(decideNext(head(5, 'delta', 'pending'), 4, null)).toEqual({ type: 'wait' })
  })

  it('skips to the next snapshot when the receipt failed for good', () => {
    expect(decideNext(head(5, 'delta', 'failed'), 4, 9)).toEqual({ type: 'skip-to-snapshot', snapshotSeq: 9 })
  })

  it('is blocked when the receipt failed and no later snapshot exists', () => {
    expect(decideNext(head(5, 'delta', 'failed'), 4, null)).toEqual({ type: 'blocked', reason: 'receipt-failed' })
  })

  it('is blocked on a delta after a missing seq', () => {
    expect(decideNext(head(7), 4, null)).toEqual({ type: 'blocked', reason: 'missing-seq' })
  })

  it('lets a snapshot jump over a gap, since it carries the complete stock', () => {
    expect(decideNext(head(9, 'snapshot'), 4, null)).toEqual({ type: 'apply' })
    expect(decideNext(head(9, 'snapshot', 'pending'), 4, null)).toEqual({ type: 'wait' })
  })
})
