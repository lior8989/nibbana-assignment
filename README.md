# StockStream — Backlog Sync Processor

Drains the `queue_messages` backlog with 4 worker processes and rebuilds each
store's current stock in `store_stock`, recording every applied update in
`apply_log`. Full spec: [ASSIGNMENT.md](ASSIGNMENT.md).

> Work in progress — the run command and design notes will be added as the
> processor is built. See `DESIGN.md` (coming) for the design.

## Prerequisites

- Node.js ≥ 20
- Docker (for Postgres 16)

## Setup

```bash
npm install
npm run db:up    # docker compose up -d --wait  (Postgres on localhost:5439)
npm run seed     # applies schema.sql, resets, fills the queue
npm run migrate  # optional: `npm start` applies migrations itself
```

## Run

```bash
npm run seed && npm start   # start immediately after seeding
```

`npm start` applies migrations, then starts the supervisor, which runs **4 worker OS
processes**. A crashed or killed worker is restarted in its slot (up to 20 restarts).
The app exits **0** once every worker has finished.

Check the result afterwards:

```bash
npm run verify   # reconciles store_stock + apply_log against an independent replay of the queue
```

Hostile variants: `node seed.js --poison` (one receipt never uploads) and `SEED=7 npm run seed`.

Connection string (override with `DATABASE_URL`):
`postgres://postgres:postgres@localhost:5439/stockstream`

## Development

```bash
npm run typecheck   # TypeScript type check
npm test            # unit + integration tests (Vitest; needs Postgres running)
npm run test:unit   # unit tests only
```

Integration tests (`*.int.test.ts`) create and drop their own `stockstream_test_*`
databases, so they never touch the seeded data.
