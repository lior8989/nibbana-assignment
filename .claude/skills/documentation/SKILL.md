---
name: documentation
description: Documentation rules for this repository - TSDoc on all exported/public members, comments for non-trivial internal logic, and API docs (Swagger/OpenAPI) for any endpoint. Use on every code change.
---

# Documentation

## Code documentation

- **Every exported / public member** (function, class, method, interface,
  type, constant) gets a TSDoc comment (`/** ... */`) describing:
  - what it does and *why it exists* (one or two lines is often enough);
  - parameters and return value when not obvious from names/types;
  - errors thrown and side effects (DB writes, locks taken, transactions);
  - concurrency/ordering guarantees the caller relies on.
- **Internal code** is commented only where it is not trivial: invariants,
  non-obvious SQL (locking, isolation, why a clause exists), the reason for
  an ordering, or a deliberate trade-off. Do not comment what the code
  already says.
- Comments must stay true: when code changes, update or delete the comments
  it invalidates.

## SQL

- Every added table, column, index, and constraint has a short comment in
  its migration file explaining what it is for.

## APIs

- If the project exposes any HTTP endpoint, it must be described in an
  OpenAPI/Swagger spec (with the auto UI if one is served), including
  descriptions, parameters, request/response schemas, and error responses.

## Project documents

- `README.md` — how to run everything (one command brings up all workers),
  how to run the tests.
- `DESIGN.md` — written by the project owner; code changes that affect a
  documented decision must be flagged so the owner can update it.
- `AI-USAGE.md` — written by the project owner; do not write it on their behalf.
