---
name: testing
description: Testing rules for this repository - unit tests for all code, endpoint tests for any endpoint, worker/integration tests for workers, re-running relevant tests after every change, and a full end-to-end verification when the project is finished. Use on every code change.
---

# Testing

## What must be tested

- **Unit tests for every unit of logic.** Pure functions and classes get
  direct tests, including edge and error cases, not just the happy path.
- **Endpoint tests** for every HTTP endpoint, if any exist (status codes,
  validation, response shape).
- **Worker tests.** Workers / the supervisor are tested too:
  - integration tests against a real Postgres (docker compose) for the
    DB-facing code — SQL, transactions, locking behaviour;
  - multi-process tests where behaviour depends on concurrency
    (several workers on the same data);
  - failure tests where it matters (process killed mid-work, restart).
- Every bug that is fixed gets a regression test first.

## Conventions

- Framework: **Vitest** (`npm test`). Tests live under `test/`, mirroring
  `src/` (e.g. `src/foo/bar.ts` → `test/foo/bar.test.ts`).
- Integration tests that need Postgres are named `*.int.test.ts` and must
  clean up / isolate their own data.
- Inject dependencies (DB, clock, worker id) so logic can be tested without
  I/O; use real Postgres rather than mocking SQL when the SQL itself is
  what's being verified.
- Tests must be deterministic: no reliance on wall-clock timing without
  control, no order dependence between tests.

## After every change

1. Run the tests related to the changed code (and their dependants).
2. Run `npm run typecheck`.
3. Report the actual results to the user (pass/fail output), never assume.
4. Never commit with failing tests.

## When the project is finished

1. Run the whole suite (`npm test`) and the typecheck.
2. Run the real system end-to-end: `docker compose up`, `node seed.js`,
   start the app immediately, wait for exit code 0.
3. Run the reconciliation checks (store_stock / apply_log vs. the update
   stream) and the chaos scenarios (kill a worker mid-run, restart, re-seed
   with a different `SEED`).
4. Report the results honestly, including anything that failed.
