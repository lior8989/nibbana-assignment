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
```

Connection string (override with `DATABASE_URL`):
`postgres://postgres:postgres@localhost:5439/stockstream`

## Development

```bash
npm run typecheck   # TypeScript type check
npm test            # unit + integration tests (Vitest)
```
