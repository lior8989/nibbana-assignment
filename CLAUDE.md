# StockStream Backlog Sync Processor

Assignment spec: [ASSIGNMENT.md](ASSIGNMENT.md). Stack: TypeScript (Node ≥ 20,
ESM), `pg` driver, Vitest, Postgres 16 via docker compose.

## Mandatory skills — apply to EVERY code change (add / edit / delete)

- `solid-design-patterns` — [.claude/skills/solid-design-patterns/SKILL.md](.claude/skills/solid-design-patterns/SKILL.md)
- `performance` — [.claude/skills/performance/SKILL.md](.claude/skills/performance/SKILL.md)
- `design-performance-balance` — [.claude/skills/design-performance-balance/SKILL.md](.claude/skills/design-performance-balance/SKILL.md)
- `testing` — [.claude/skills/testing/SKILL.md](.claude/skills/testing/SKILL.md)
- `documentation` — [.claude/skills/documentation/SKILL.md](.claude/skills/documentation/SKILL.md)

## Hard constraints (from the assignment)

- Never modify `schema.sql` or `seed.js`. Schema additions go in our own migration files.
- No ORMs, no queue/job frameworks. Plain `pg` only.
- Exactly 4 worker OS processes; Postgres is the only shared channel (no IPC, shared memory, or local files for coordination).

## Ownership

- The owner delegated closing the design (risks + handling) to Claude due to time
  pressure. Keep every decision short and visible, and summarise each task so the owner
  can review, correct, and defend it. Never change an agreed decision without asking.
- `DESIGN.md` and `AI-USAGE.md` were drafted by Claude at the owner's request. Keep them
  true to the code, and keep `AI-USAGE.md` honest about who did what.

## Git workflow

- One branch per task (see the branch plan agreed with the owner). Never commit directly to `main`.
- Before any commit: show the owner the changes and the test results, and wait for explicit approval.
- After approval: commit with a descriptive message → push → open a PR → merge into `main`.
- Ask the owner before any complicated or hard-to-reverse decision.

## Commands

```bash
npm run db:up       # start Postgres (docker compose)
npm run seed        # apply schema.sql, reset, fill the queue
npm run migrate     # apply our additions in migrations/ (idempotent)
npm start           # migrate + run the 4-worker fleet; exits 0 when done
npm run verify      # reconcile store_stock/apply_log against an independent replay
npm run typecheck   # tsc --noEmit
npm test            # vitest: unit + integration (*.int.test.ts needs Postgres)
npm run test:unit   # unit tests only, no DB needed
```
