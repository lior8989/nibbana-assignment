/** A store's stock: item key → value (a number for quantities, but any JSON value is kept as-is). */
export type Stock = Record<string, unknown>

/** The two update kinds a POS gateway sends. */
export type UpdateKind = 'snapshot' | 'delta'

/** Thrown when a payload does not match the documented snapshot/delta shape. */
export class InvalidPayloadError extends Error {
  override readonly name = 'InvalidPayloadError'
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Computes a store's stock after applying one update. Pure: never mutates `current`.
 *
 * - `snapshot` `{ stock }` replaces the whole stock (items missing from it are gone).
 * - `delta` `{ set?, unset? }` copies the stock, applies `set` (new final values, which also
 *   adds new items), then removes every key in `unset`. When one delta both sets and unsets
 *   the same item, `unset` wins (decision: follows the payload order and "unset delists").
 *
 * @throws InvalidPayloadError when the payload shape is invalid.
 */
export function applyUpdate(current: Stock, kind: UpdateKind, payload: unknown): Stock {
  if (!isPlainObject(payload)) throw new InvalidPayloadError(`${kind} payload must be an object`)

  if (kind === 'snapshot') {
    if (!isPlainObject(payload.stock)) throw new InvalidPayloadError('snapshot.stock must be an object')
    return { ...payload.stock }
  }

  const { set = {}, unset = [] } = payload
  if (!isPlainObject(set)) throw new InvalidPayloadError('delta.set must be an object')
  if (!Array.isArray(unset) || !unset.every((k) => typeof k === 'string')) {
    throw new InvalidPayloadError('delta.unset must be an array of strings')
  }
  const next: Stock = { ...current, ...set }
  for (const key of unset) delete next[key]
  return next
}
