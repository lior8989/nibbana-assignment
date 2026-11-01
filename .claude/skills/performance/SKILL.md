---
name: performance
description: Consider memory, CPU, I/O, database load and scalability on every code change (add / edit / delete) in this repository. Use on every code change, refactor, and code review.
---

# Performance & Scalability

Every code change must be evaluated for its cost at scale — assume the
data volume and the number of stores can grow by orders of magnitude.

## Database (usually the bottleneck here)

- **Round trips:** batch work where correctness allows; avoid N+1 query loops.
- **Indexes:** every query used in a hot loop must be backed by an index.
  Verify with `EXPLAIN (ANALYZE, BUFFERS)` when in doubt and note the result.
- **Transactions:** keep them short. Never hold a transaction (or row locks)
  open while waiting on timers, sleeps, or anything outside the DB.
- **Locking:** prefer the narrowest lock that is correct. Know which rows /
  advisory locks a transaction takes, and avoid lock ordering that can deadlock.
- **Connection pool:** size it deliberately per process; never leak clients
  (always release in `finally`).
- **Polling:** idle polling must be cheap (index-only / tiny queries) and
  bounded (≤ ~500 ms interval per the assignment); consider `LISTEN/NOTIFY`.
- **Payloads:** select only the columns that are needed; avoid fetching
  large JSONB repeatedly when a smaller value suffices.

## Memory

- Never load an unbounded result set into memory; page or stream it.
- Avoid retaining per-item state forever in long-lived processes
  (caches/maps must be bounded or cleared).
- Prefer in-place / streaming transformations over building large copies.

## CPU

- Keep hot loops free of unnecessary allocations, JSON (de)serialisation,
  and regex compilation.
- Choose data structures by access pattern (Map/Set for lookups, arrays for
  ordered iteration).

## Concurrency & scaling

- Work must spread across all workers; one slow unit of work must not
  block others (no head-of-line blocking).
- Design so that adding workers increases throughput instead of contention.
- Backoff for retries — never hot-spin on a failing item.

## Before finishing a change

- [ ] No unbounded memory growth or result sets.
- [ ] Hot-path queries are indexed and round trips are minimised.
- [ ] Transactions/locks are short and cannot deadlock under concurrency.
- [ ] Idle behaviour is cheap.
- [ ] Any trade-off is weighed per the `design-performance-balance` skill.
