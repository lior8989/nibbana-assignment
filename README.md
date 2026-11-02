# StockStream — Backlog Sync Processor

Drains the `queue_messages` backlog with **4 worker OS processes** and rebuilds each
store's current stock in `store_stock`, recording every applied update exactly once in
`apply_log`. Spec: [ASSIGNMENT.md](ASSIGNMENT.md) · Design: [DESIGN.md](DESIGN.md) ·
AI usage: [AI-USAGE.md](AI-USAGE.md).

## Quick start

Prerequisites: Node.js ≥ 20, Docker.

```bash
npm install
npm run db:up               # Postgres 16 on localhost:5439 (docker compose)
npm run seed && npm start   # seed, then start immediately — one command runs all 4 workers
npm run verify              # check the result against an independent replay
```

`npm start` exits **0** when everything that can be done is done (~25 s on the default
seed: the run waits for receipt uploads that finish up to ~25 s after seeding).

Hostile variants: `node seed.js --poison` (one receipt never uploads) and a different
seed — `SEED=7 npm run seed` (bash) / `$env:SEED=7; npm run seed` (PowerShell).

Connection string (override with `DATABASE_URL`):
`postgres://postgres:postgres@localhost:5439/stockstream`

## How it works (short)

- **Supervisor** (`src/main.ts`) applies our migrations, then keeps 4 worker processes
  running: a worker that exits 0 is done; a crashed/killed one is restarted (≤ 20 times).
  Workers are started with `spawn` (no IPC) — Postgres is the only shared channel.
- **Workers** claim a store via a 5 s lease in `store_claims`, then process its messages in
  `seq` order, **one transaction per message**: lease check + `store_stock` + `apply_log` +
  queue row status commit together. Up to 8 stores per worker run concurrently.
- **Rules per message** (`src/domain/decide.ts`): apply the next seq when its receipt is
  ready; skip retransmits; wait while a receipt uploads; on a receipt that failed for good,
  skip to the next snapshot or, if none, leave the store blocked so the run can still finish.
- Details, risks, and trade-offs: [DESIGN.md](DESIGN.md).

| Exit code | Meaning |
|---|---|
| `0` | all workers finished — nothing actionable or waiting remains |
| `1` | a worker exceeded the restart limit, or the app was stopped (Ctrl+C) |

## Project layout

```
src/
  main.ts              app entry: migrate → supervisor (npm start)
  worker-main.ts       worker process entry
  supervisor/          process supervision (spawn, restart, exit code)
  worker/              scheduling loop, per-message transaction, all SQL
  domain/              pure rules: applyUpdate, decideNext
  db/                  pool, transaction helper, migration runner
  verify/              independent replay + reconciliation (npm run verify)
migrations/            our additive schema changes (schema.sql is untouched)
scripts/chaos/         chaos scenarios (npm run chaos)
test/                  unit + integration tests (Vitest)
```

## Tests

```bash
npm run typecheck   # TypeScript type check
npm test            # unit + integration tests (needs Postgres running)
npm run test:unit   # unit tests only
```

Integration tests (`*.int.test.ts`) create and drop their own `stockstream_test_*`
databases, so they never touch the seeded data.

## Chaos testing

```bash
npm run chaos                       # all scenarios (~3 min)
npm run chaos kill-one-worker       # or pick scenarios by name
```

Each scenario seeds, runs the app while injecting failures, then reconciles the result
with `verify`. App output goes to `logs/chaos-<scenario>.log`.

| Scenario | What it does |
|---|---|
| `baseline` | normal run (SEED=42) |
| `poison-other-seed` | SEED=7 with `--poison` (a receipt that never uploads) |
| `kill-one-worker` | SIGKILL one worker mid-run; the supervisor restarts it |
| `kill-workers-repeatedly` | SIGKILL a random worker every second, 6 times, with `--poison` |
| `restart-whole-app` | SIGKILL the supervisor and all workers mid-run, then start the app again |
| `orphaned-workers` | SIGKILL only the supervisor; its workers keep running while a second app starts alongside them |
