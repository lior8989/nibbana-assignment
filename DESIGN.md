# DESIGN — StockStream Backlog Sync Processor

## 1. Overview

The processor drains `queue_messages` with **4 worker OS processes** and rebuilds every
store's current stock in `store_stock`, logging each applied update once in `apply_log`.

```
npm start ─► main.ts: run migrations ─► Supervisor ─► 4 × worker process (spawn, no IPC)
                                                         │
                     Postgres (the only shared channel) ◄┘
   queue_messages ──► per-store lease (store_claims) ──► one transaction per message:
                                                         store_stock + apply_log + queue status
```

Core idea: **correctness lives in the database, not in the processes.** Every message is
handled in one transaction that commits the stock change, the audit row, and the queue
row's status together, and only if the worker still owns the store. Any process can die
at any moment; whatever committed is consistent, and whatever didn't is simply redone.

All additions to the schema are in `migrations/` (`schema.sql` and `seed.js` are untouched):

| Addition | Purpose |
|---|---|
| `queue_messages.processed_at`, `.outcome` (`applied` / `duplicate` / `superseded`) | per-row processing status; partial index on pending rows |
| unique `apply_log(message_id)` and `apply_log(chain_id, store_id, seq)` | the DB itself refuses to log (bill) an update twice |
| `store_claims(chain_id, store_id, locked_by, locked_until, failures, last_error)` | per-store lease + failure tracking |
| `schema_migrations` | migration bookkeeping |

## 2. Risks identified

| # | Risk | Where I found it |
|---|---|---|
| R1 | **Duplicate messages.** Gateways retransmit until acknowledged, so the same update (same `message_id`) appears more than once. | Spec ("retransmit … until acknowledged"); `seed.js` (`DUP_RATE = 0.05`); data: 94 duplicate rows with SEED=42 |
| R2 | **Out-of-order arrival.** `queue_messages.id` is network arrival order, not store order. | Spec ("whatever order the network delivers"); `seed.js` shuffles all rows |
| R3 | **Receipt not ready yet.** An update may not be processed before its receipt file is available; some uploads complete up to ~25 s after seeding. | Spec (compliance rule, "~30 seconds after you seed"); `seed.js` (`DELAY_RATE`, 3–25 s); data: ~240 delayed receipts |
| R4 | **Receipt failed for good** (`ready_at IS NULL`). That update can never be processed, and every later delta of the store depends on it. | Spec ("failed for good"); `seed.js --poison` |
| R5 | **Gateway restart → new snapshot mid-stream.** The snapshot must replace, not merge. | Spec (power cycles); data: 3 stores with a second snapshot |
| R6 | **A delta that both `set`s and `unset`s the same item.** The spec does not define the order. | Data: 143 such deltas with SEED=42 |
| R7 | **Process death mid-update** (OOM kill, redeploy): partial writes could desync `store_stock` and `apply_log`. | Spec (requirement 3) |
| R8 | **Two workers on one store.** A worker stalls, its lease expires, another takes over, and the first wakes up and writes. Also orphaned workers after the supervisor is killed, running next to a new app instance. | Reasoning about leases and process death |
| R9 | **One slow/broken store holds up others or the finish** (waiting receipt, failed receipt, or an unexpected error such as a malformed payload). | Spec (requirements 4 and 5) |
| R10 | **Exit condition.** "Queue empty" never happens with a failed receipt; exiting while receipts are still uploading would lose work. | Spec (requirement 5) + R3/R4 |
| R11 | **Full app restart / re-seed** with leftover state in our own tables (seed truncates only its four tables). | Reading `seed.js` (TRUNCATE list); spec (evaluation re-seeds with a different SEED) |

Checked and **not present** in the data (handled anyway, see §3): same `seq` with different
`message_id`, gaps in `seq`.

## 3. How each risk is handled

**Processing rules** — one pure function, `decideNext` (`src/domain/decide.ts`), decides
what to do with a store's *head* (its lowest-seq unprocessed message), given the store's
`last_seq`:

1. `seq <= last_seq` → **discard** (mark `duplicate` if its `message_id` is in `apply_log`,
   else `superseded`). Never applied, never logged.
2. A delta must be exactly `last_seq + 1`; a delta after a gap → **blocked**. A snapshot may
   jump a gap, because it carries the complete stock.
3. Receipt ready (`ready_at <= now()`, DB clock) → **apply**; still uploading → **wait**.
4. Receipt failed → **skip to the next snapshot** if one exists (in-between rows marked
   `superseded`), otherwise **blocked**.

| Risk | Handling | Considered and rejected |
|---|---|---|
| R1 duplicates | Apply by `seq` order; when applying, all rows with the same `message_id` are marked (`applied` + `duplicate`); late copies are discarded by rule 1. Unique indexes on `apply_log` are a DB-level backstop for billing. | Dedup only in application code — a bug would double-bill; the DB constraint makes it impossible. |
| R2 ordering | Only `last_seq + 1` is applied; arrival order is used only for fairness (oldest waiting store first). | Processing in `id` order — wrong stock. |
| R3 pending receipt | Rule 3 **wait**. The worker releases the store immediately and works on others; the store is picked again once the receipt is ready. Readiness uses the DB clock so all workers agree. | Holding the store while waiting — blocks a worker slot; applying before the receipt — violates compliance. |
| R4 failed receipt | Rule 4. With a later snapshot the store recovers exactly (the snapshot is the full truth); skipped rows are `superseded`, not logged, not billed. Without one, the store stays at its last good state and is excluded from "remaining work". | Applying later deltas while skipping the failed one — stock built on a wrong base; waiting forever — never exits. |
| R5 re-snapshot | `applyUpdate`: a snapshot **replaces** the whole stock; a delta copies it and applies `set`, then `unset`. | Merging snapshots into existing stock — keeps delisted items. |
| R6 set+unset | **`set` first, then `unset`** (item ends up removed) — follows the payload's key order and "unset delists an item". Documented assumption; one line to change if the business says otherwise. | — |
| R7 crash mid-update | **One transaction per message**: lease renewal, `store_stock` upsert, `apply_log` insert, queue status update. Postgres rolls back an interrupted transaction automatically, so state is always "before" or "after" a message. | One transaction per batch — a crash loses more work and holds locks longer; separate transactions per table — the log and stock can disagree. |
| R8 two workers | **Lease fence**: each transaction starts with `UPDATE store_claims … WHERE locked_by = me`. If another worker took the store over, 0 rows → abort without writing. The UPDATE also row-locks the claim, serialising any competing claim until commit. | Trusting the lease alone — a stalled worker could write after expiry. |
| R9 isolation | Per-store leases (5 s, renewed each message); up to 8 stores per worker in parallel; waiting/blocked stores are released. A store whose processing throws is retried with 1 s backoff and **set aside after 5 failures** (`store_claims.failures`, `last_error`). | Retrying forever — a malformed payload would keep the run alive forever. |
| R10 exit | Each worker exits 0 when the DB says no store is **actionable or waiting** (blocked and set-aside stores don't count). Stores claimed by other (possibly dead) workers still count, so live workers wait for the lease to expire and take them over. Supervisor exits 0 when all 4 workers exited 0. | "Queue empty" — never true with a failed receipt; a fixed timeout — either too early or too slow. |
| R11 restart / re-seed | All state is in Postgres, so a restarted app resumes where it stopped. Leftover leases expire within 5 s; failure counters are reset at app start; migrations are idempotent and guarded by an advisory lock. | Clearing all leases at start — unsafe if orphaned workers are still running (the fence makes either choice safe, but expiry is the conservative one). |

### Coordination design

- **Lock unit = the store.** Updates of one store are strictly ordered, so the store, not the
  message, is what must have a single owner.
- **Lease in a table** (`store_claims`) rather than alternatives:
  - `SELECT … FOR UPDATE SKIP LOCKED` on message rows — locks die at each commit and only
    cover rows that exist at lock time; good for independent jobs, not ordered ones.
  - Advisory locks — tied to one connection; workable, but the lease row also gives a place
    for failure tracking and is visible for debugging.
  - A plain busy flag — racy and stuck forever after a crash.
- **Claiming** is one atomic upsert: take the row if free or expired and not set aside.
- **Scheduling loop** (`src/worker/worker.ts`): claim up to 8 stores, drain each (one
  transaction per message) until it waits/blocks, release, repeat. When busy it loops
  immediately; when idle it polls every **250 ms** (spec: ≤ 500 ms).
- **`LISTEN/NOTIFY` rejected**: a receipt becomes ready by the passage of time, not by a
  write, so it produces no notification; polling is needed anyway.
- **Supervisor** keeps exactly 4 workers: exit 0 → slot done; crash/kill → restarted in the
  same slot (0.5 s delay, max 20 restarts). Workers exit 143 on SIGTERM so an externally
  terminated worker is also restarted. Workers are started with `spawn`, not `fork`, so no
  IPC channel exists. Dynamic scaling (1–4 workers by load) was rejected: the spec requires
  exactly 4.

## 4. How I convinced myself it works

1. **Inspected the seed and data** with SQL before designing (counts in §2).
2. **54 automated tests** (`npm test`):
   - pure rules: `applyUpdate`, `decideNext`, the reference replay;
   - integration on an isolated database: ordering, duplicates (early and late), waiting
     receipts, failed receipt with and without a later snapshot, the lease fence, a forced
     mid-transaction failure leaving nothing written, an 8-way claim race (exactly one wins),
     lease takeover, set-aside of a broken store;
   - 4 concurrent workers on real `seed.js --poison` data, reconciled at the end;
   - supervisor with fake processes and with real OS processes (crash → restart → exit 0).
3. **`npm run verify`** — reconciles `store_stock` (stock, `version`, `last_seq`) and
   `apply_log` (exact set, once each, in seq order) against an independent, deliberately
   naive replay of the queue.
4. **`npm run chaos`** — six end-to-end scenarios on the real app, each seeded fresh and
   reconciled with `verify`; all pass (exit 0 + verify OK, ~25 s each):

| Scenario | Injected failure |
|---|---|
| `baseline` | none (SEED=42) |
| `poison-other-seed` | SEED=7 + a receipt that never uploads |
| `kill-one-worker` | SIGKILL one worker mid-run |
| `kill-workers-repeatedly` | SIGKILL a random worker every second, 6 times, + poison |
| `restart-whole-app` | SIGKILL supervisor and all workers mid-run, start again |
| `orphaned-workers` | SIGKILL only the supervisor; its workers keep running beside a second app |

Logs confirm the failures really happened (1 and 6 worker restarts; two full fleets in the
restart/orphan scenarios).

## 5. Known limitations / left rough

- **Finding work scans all pending heads each poll** (`DISTINCT ON` over pending rows). Fine
  for this backlog; at large scale I would keep a per-store "next seq / state" table updated
  in the same transaction.
- **Rules are duplicated** in TypeScript (`decideNext`) and SQL (finding work / exit check);
  kept in sync by tests, not by construction.
- **~7 round trips per message.** Batching several messages of a store per transaction would
  be faster, at the cost of more lost work on a crash.
- **Blocked stores are silent** — visible as pending queue rows and in `store_claims`, but no
  alerting.
- **R6 is an assumption** (set-then-unset).
- **The lease fence was never triggered by the chaos runs** (no lost-claim steps); it is
  proven only by an integration test.
- **The reference replay shares `applyUpdate`** with the workers, so a bug there would not be
  caught by `verify` (it has its own unit tests).
- A killed supervisor leaves orphaned workers; they are harmless (fence + leases) and exit
  on their own, but are not cleaned up actively.
